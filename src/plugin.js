/* global navigator */
/* eslint-disable no-inline-comments, no-console */
import {version as VERSION} from '../package.json';
import window from 'global/window';
import document from 'global/document';
import WebVRPolyfill from 'webvr-polyfill/src/webvr-polyfill';
import videojs from 'video.js';
import * as THREE from 'three';
import VRControls from '../vendor/three/VRControls.js';
import VREffect from '../vendor/three/VREffect.js';
import OrbitOrientationContols from './orbit-orientation-controls.js';
import * as utils from './utils';
import CanvasPlayerControls from './canvas-player-controls';
import OmnitoneController from './omnitone-controller';
import VRHUD from './vr-hud';
import VRGallery from './vr-gallery';

// import controls so they get regisetered with videojs
import './cardboard-button';
import './big-vr-play-button';

// Default options for the plugin.
const defaults = {
  debug: false,
  omnitone: false,
  forceCardboard: false,
  omnitoneOptions: {},
  projection: 'AUTO',
  sphereDetail: 32,
  disableTogglePlay: false,
  // New VR HUD options
  enableVRHUD: true,
  enableVRGallery: true,
  showHUDOnStart: true,
  hudAutoHideDelay: 5000, // ms before HUD auto-hides (0 to disable)
  // Callbacks for navigation
  onNext: null,
  onPrevious: null,
  onMediaSelect: null,
  onGallery: null,
  onExit: null,
  onProjectionChange: null,
  onFavorite: null,
  // Media items for gallery
  mediaItems: []
};

const errors = {
  'web-vr-out-of-date': {
    headline: '360 is out of date',
    type: '360_OUT_OF_DATE',
    message: "Your browser supports 360 but not the latest version. See <a href='http://webvr.info'>http://webvr.info</a> for more info."
  },
  'web-vr-not-supported': {
    headline: '360 not supported on this device',
    type: '360_NOT_SUPPORTED',
    message: "Your browser does not support 360. See <a href='http://webvr.info'>http://webvr.info</a> for assistance."
  },
  'web-vr-hls-cors-not-supported': {
    headline: '360 HLS video not supported on this device',
    type: '360_NOT_SUPPORTED',
    message: "Your browser/device does not support HLS 360 video. See <a href='http://webvr.info'>http://webvr.info</a> for assistance."
  }
};

const Plugin = videojs.getPlugin('plugin');
const Component = videojs.getComponent('Component');

class VR extends Plugin {
  constructor(player, options) {
    const settings = videojs.mergeOptions(defaults, options);

    super(player, settings);

    this.options_ = settings;
    this.player_ = player;
    this.bigPlayButtonIndex_ = player.children().indexOf(player.getChild('BigPlayButton')) || 0;

    // custom videojs-errors integration boolean
    this.videojsErrorsSupport_ = !!videojs.errors;

    if (this.videojsErrorsSupport_) {
      player.errors({errors});
    }

    // IE 11 does not support enough webgl to be supported
    // older safari does not support cors, so it wont work
    if (videojs.browser.IE_VERSION || !utils.corsSupport) {
      // if a player triggers error before 'loadstart' is fired
      // video.js will reset the error overlay
      this.player_.on('loadstart', () => {
        this.triggerError_({code: 'web-vr-not-supported', dismiss: false});
      });
      return;
    }

    this.polyfill_ = new WebVRPolyfill({
      // do not show rotate instructions
      ROTATE_INSTRUCTIONS_DISABLED: true
    });
    this.polyfill_ = new WebVRPolyfill();

    this.handleVrDisplayActivate_ = videojs.bind(this, this.handleVrDisplayActivate_);
    this.handleVrDisplayDeactivate_ = videojs.bind(this, this.handleVrDisplayDeactivate_);
    this.handleResize_ = videojs.bind(this, this.handleResize_);
    this.animate_ = videojs.bind(this, this.animate_);

    this.setProjection(this.options_.projection);

    // any time the video element is recycled for ads
    // we have to reset the vr state and re-init after ad
    this.on(player, 'adstart', () => player.setTimeout(() => {
      // if the video element was recycled for this ad
      if (!player.ads || !player.ads.videoElementRecycled()) {
        this.log('video element not recycled for this ad, no need to reset');
        return;
      }

      this.log('video element recycled for this ad, reseting');
      this.reset();

      this.one(player, 'playing', this.init);
    }), 1);

    this.on(player, 'loadedmetadata', this.init);
  }

  changeProjection_(projection) {
    projection = utils.getInternalProjectionName(projection);
    // don't change to an invalid projection
    if (!projection) {
      projection = 'NONE';
    }

    const position = {x: 0, y: 0, z: 0 };

    if (this.scene) {
      this.scene.remove(this.movieScreen);
      // Also remove stereo eye meshes if they exist
      if (this.movieScreenLeft) {
        this.scene.remove(this.movieScreenLeft);
        this.movieScreenLeft = null;
      }
      if (this.movieScreenRight) {
        this.scene.remove(this.movieScreenRight);
        this.movieScreenRight = null;
      }
    }
    if (projection === 'AUTO') {
      // mediainfo cannot be set to auto or we would infinite loop here
      // each source should know whatever they are 360 or not, if using AUTO
      if (this.player_.mediainfo && this.player_.mediainfo.projection && this.player_.mediainfo.projection !== 'AUTO') {
        const autoProjection = utils.getInternalProjectionName(this.player_.mediainfo.projection);

        return this.changeProjection_(autoProjection);
      }
      return this.changeProjection_('NONE');
    } else if (projection === '360') {
      this.movieGeometry = new THREE.SphereBufferGeometry(256, this.options_.sphereDetail, this.options_.sphereDetail);
      this.movieMaterial = new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.BackSide });

      this.movieScreen = new THREE.Mesh(this.movieGeometry, this.movieMaterial);
      this.movieScreen.position.set(position.x, position.y, position.z);

      this.movieScreen.scale.x = -1;
      this.movieScreen.quaternion.setFromAxisAngle({x: 0, y: 1, z: 0}, -Math.PI / 2);
      this.scene.add(this.movieScreen);
    } else if (projection === '360_LR' || projection === '360_TB') {
      // Left eye view - use SphereBufferGeometry and modify UVs directly
      let leftGeometry = new THREE.SphereBufferGeometry(
        256,
        this.options_.sphereDetail,
        this.options_.sphereDetail
      );

      // Get UV attribute from buffer geometry
      let uvAttribute = leftGeometry.getAttribute('uv');
      let uvArray = uvAttribute.array;

      // Modify UVs for left eye
      for (let i = 0; i < uvArray.length; i += 2) {
        if (projection === '360_LR') {
          uvArray[i] *= 0.5; // x coordinate
        } else {
          uvArray[i + 1] = uvArray[i + 1] * 0.5 + 0.5; // y coordinate
        }
      }
      uvAttribute.needsUpdate = true;

      const leftMaterial = new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.BackSide });

      this.movieScreenLeft = new THREE.Mesh(leftGeometry, leftMaterial);
      this.movieScreenLeft.scale.x = -1;
      this.movieScreenLeft.quaternion.setFromAxisAngle({x: 0, y: 1, z: 0}, -Math.PI / 2);
      // display in left eye only
      this.movieScreenLeft.layers.set(1);
      this.scene.add(this.movieScreenLeft);

      // Right eye view - use SphereBufferGeometry and modify UVs directly
      const rightGeometry = new THREE.SphereBufferGeometry(
        256,
        this.options_.sphereDetail,
        this.options_.sphereDetail
      );

      // Get UV attribute from buffer geometry
      uvAttribute = rightGeometry.getAttribute('uv');
      uvArray = uvAttribute.array;

      // Modify UVs for right eye
      for (let i = 0; i < uvArray.length; i += 2) {
        if (projection === '360_LR') {
          uvArray[i] = uvArray[i] * 0.5 + 0.5; // x coordinate
        } else {
          uvArray[i + 1] *= 0.5; // y coordinate
        }
      }
      uvAttribute.needsUpdate = true;

      const rightMaterial = new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.BackSide });

      this.movieScreenRight = new THREE.Mesh(rightGeometry, rightMaterial);
      this.movieScreenRight.scale.x = -1;
      this.movieScreenRight.quaternion.setFromAxisAngle({x: 0, y: 1, z: 0}, -Math.PI / 2);
      // display in right eye only
      this.movieScreenRight.layers.set(2);
      this.scene.add(this.movieScreenRight);

      // Store references for cleanup and mono toggle
      this.movieScreen = this.movieScreenLeft;
      this.movieGeometry = leftGeometry;
      this.movieMaterial = leftMaterial;
    } else if (projection === '360_CUBE') {
      // Use BoxBufferGeometry instead of deprecated BoxGeometry
      this.movieGeometry = new THREE.BoxBufferGeometry(256, 256, 256);
      this.movieMaterial = new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.BackSide });

      // Define UV coordinates for each face
      const left = [new THREE.Vector2(0, 0.5), new THREE.Vector2(0.333, 0.5), new THREE.Vector2(0.333, 1), new THREE.Vector2(0, 1)];
      const right = [new THREE.Vector2(0.333, 0.5), new THREE.Vector2(0.666, 0.5), new THREE.Vector2(0.666, 1), new THREE.Vector2(0.333, 1)];
      const top = [new THREE.Vector2(0.666, 0.5), new THREE.Vector2(1, 0.5), new THREE.Vector2(1, 1), new THREE.Vector2(0.666, 1)];
      const bottom = [new THREE.Vector2(0, 0), new THREE.Vector2(0.333, 0), new THREE.Vector2(0.333, 0.5), new THREE.Vector2(0, 0.5)];
      const front = [new THREE.Vector2(0.333, 0), new THREE.Vector2(0.666, 0), new THREE.Vector2(0.666, 0.5), new THREE.Vector2(0.333, 0.5)];
      const back = [new THREE.Vector2(0.666, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 0.5), new THREE.Vector2(0.666, 0.5)];

      // BoxBufferGeometry has 24 vertices (4 per face, 6 faces)
      // UV attribute has 48 values (2 per vertex)
      // Face order in BoxBufferGeometry: +X, -X, +Y, -Y, +Z, -Z (right, left, top, bottom, front, back)
      const uvAttribute = this.movieGeometry.getAttribute('uv');
      const uvArray = uvAttribute.array;

      // Helper to set UVs for a face (4 vertices, 8 UV values starting at faceIndex*8)
      const setFaceUVs = (faceIndex, corners) => {
        const baseIdx = faceIndex * 8;
        // Vertex order for each face in BoxBufferGeometry: 0,1,2,3 -> corners[3],corners[2],corners[0],corners[1]

        uvArray[baseIdx] = corners[3].x; uvArray[baseIdx + 1] = corners[3].y;
        uvArray[baseIdx + 2] = corners[2].x; uvArray[baseIdx + 3] = corners[2].y;
        uvArray[baseIdx + 4] = corners[0].x; uvArray[baseIdx + 5] = corners[0].y;
        uvArray[baseIdx + 6] = corners[1].x; uvArray[baseIdx + 7] = corners[1].y;
      };

      // Set UVs for each face
      setFaceUVs(0, right); // +X face
      setFaceUVs(1, left); // -X face
      setFaceUVs(2, top); // +Y face
      setFaceUVs(3, bottom); // -Y face
      setFaceUVs(4, front); // +Z face
      setFaceUVs(5, back); // -Z face

      uvAttribute.needsUpdate = true;

      this.movieScreen = new THREE.Mesh(this.movieGeometry, this.movieMaterial);
      this.movieScreen.position.set(position.x, position.y, position.z);
      this.movieScreen.rotation.y = -Math.PI;

      this.scene.add(this.movieScreen);
    } else if (projection === '180_MONO') {
      // 180 MONO: Single mesh showing full video, visible to both eyes
      const geometry = new THREE.SphereBufferGeometry(
        256,
        this.options_.sphereDetail,
        this.options_.sphereDetail,
        Math.PI, // phiStart
        Math.PI // phiLength
      );
      geometry.scale(-1, 1, 1);

      this.movieGeometry = geometry;
      this.movieMaterial = new THREE.MeshBasicMaterial({
        map: this.videoTexture
      });
      this.movieScreen = new THREE.Mesh(this.movieGeometry, this.movieMaterial);
      // Visible to all layers (mono)
      this.movieScreen.layers.enable(0);
      this.movieScreen.layers.enable(1);
      this.movieScreen.layers.enable(2);
      this.scene.add(this.movieScreen);
    } else if (projection === '180' || projection === '180_LR') {
      // 180 Stereo: Left eye view
      const leftGeometry = new THREE.SphereBufferGeometry(
        256,
        this.options_.sphereDetail,
        this.options_.sphereDetail,
        Math.PI, // phiStart
        Math.PI // phiLength
      );
      leftGeometry.scale(-1, 1, 1);

      // Modify UVs for left eye (left half of video)
      let uvAttribute = leftGeometry.getAttribute('uv');
      let uvArray = uvAttribute.array;
      for (let i = 0; i < uvArray.length; i += 2) {
        uvArray[i] *= 0.5; // x coordinate
      }
      uvAttribute.needsUpdate = true;

      const leftMaterial = new THREE.MeshBasicMaterial({
        map: this.videoTexture
      });
      this.movieScreenLeft = new THREE.Mesh(leftGeometry, leftMaterial);
      this.movieScreenLeft.layers.set(1); // Left eye only
      this.scene.add(this.movieScreenLeft);

      // Right eye view
      const rightGeometry = new THREE.SphereBufferGeometry(
        256,
        this.options_.sphereDetail,
        this.options_.sphereDetail,
        Math.PI, // phiStart
        Math.PI // phiLength
      );
      rightGeometry.scale(-1, 1, 1);

      // Modify UVs for right eye (right half of video)
      uvAttribute = rightGeometry.getAttribute('uv');
      uvArray = uvAttribute.array;
      for (let i = 0; i < uvArray.length; i += 2) {
        uvArray[i] = uvArray[i] * 0.5 + 0.5; // x coordinate
      }
      uvAttribute.needsUpdate = true;

      const rightMaterial = new THREE.MeshBasicMaterial({
        map: this.videoTexture
      });
      this.movieScreenRight = new THREE.Mesh(rightGeometry, rightMaterial);
      this.movieScreenRight.layers.set(2); // Right eye only
      this.scene.add(this.movieScreenRight);

      // Store references for cleanup and mono toggle
      this.movieScreen = this.movieScreenLeft;
      this.movieGeometry = leftGeometry;
      this.movieMaterial = leftMaterial;
    } else if (projection === 'EAC' || projection === 'EAC_LR') {
      const makeScreen = (mapMatrix, scaleMatrix) => {
        // "Continuity correction?": because of discontinuous faces and aliasing,
        // we truncate the 2-pixel-wide strips on all discontinuous edges,
        const contCorrect = 2;

        // Use BoxBufferGeometry instead of deprecated BoxGeometry
        this.movieGeometry = new THREE.BoxBufferGeometry(256, 256, 256);
        this.movieMaterial = new THREE.ShaderMaterial({
          side: THREE.BackSide,
          uniforms: {
            mapped: {value: this.videoTexture},
            mapMatrix: {value: mapMatrix},
            contCorrect: {value: contCorrect},
            faceWH: {value: new THREE.Vector2(1 / 3, 1 / 2).applyMatrix3(scaleMatrix)},
            vidWH: {value: new THREE.Vector2(this.videoTexture.image.videoWidth, this.videoTexture.image.videoHeight).applyMatrix3(scaleMatrix)}
          },
          vertexShader: `
varying vec2 vUv;
uniform mat3 mapMatrix;

void main() {
  vUv = (mapMatrix * vec3(uv, 1.)).xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`,
          fragmentShader: `
varying vec2 vUv;
uniform sampler2D mapped;
uniform vec2 faceWH;
uniform vec2 vidWH;
uniform float contCorrect;

const float PI = 3.1415926535897932384626433832795;

void main() {
  vec2 corner = vUv - mod(vUv, faceWH) + vec2(0, contCorrect / vidWH.y);

  vec2 faceWHadj = faceWH - vec2(0, contCorrect * 2. / vidWH.y);

  vec2 p = (vUv - corner) / faceWHadj - .5;
  vec2 q = 2. / PI * atan(2. * p) + .5;

  vec2 eUv = corner + q * faceWHadj;

  gl_FragColor = texture2D(mapped, eUv);
}`
        });

        const right = [new THREE.Vector2(0, 1 / 2), new THREE.Vector2(1 / 3, 1 / 2), new THREE.Vector2(1 / 3, 1), new THREE.Vector2(0, 1)];
        const front = [new THREE.Vector2(1 / 3, 1 / 2), new THREE.Vector2(2 / 3, 1 / 2), new THREE.Vector2(2 / 3, 1), new THREE.Vector2(1 / 3, 1)];
        const left = [new THREE.Vector2(2 / 3, 1 / 2), new THREE.Vector2(1, 1 / 2), new THREE.Vector2(1, 1), new THREE.Vector2(2 / 3, 1)];
        const bottom = [new THREE.Vector2(1 / 3, 0), new THREE.Vector2(1 / 3, 1 / 2), new THREE.Vector2(0, 1 / 2), new THREE.Vector2(0, 0)];
        const back = [new THREE.Vector2(1 / 3, 1 / 2), new THREE.Vector2(1 / 3, 0), new THREE.Vector2(2 / 3, 0), new THREE.Vector2(2 / 3, 1 / 2)];
        const top = [new THREE.Vector2(1, 0), new THREE.Vector2(1, 1 / 2), new THREE.Vector2(2 / 3, 1 / 2), new THREE.Vector2(2 / 3, 0)];

        for (const face of [right, front, left, bottom, back, top]) {
          const height = this.videoTexture.image.videoHeight;
          let lowY = 1;
          let highY = 0;

          for (const vector of face) {
            if (vector.y < lowY) {
              lowY = vector.y;
            }
            if (vector.y > highY) {
              highY = vector.y;
            }
          }

          for (const vector of face) {
            if (Math.abs(vector.y - lowY) < Number.EPSILON) {
              vector.y += contCorrect / height;
            }
            if (Math.abs(vector.y - highY) < Number.EPSILON) {
              vector.y -= contCorrect / height;
            }

            vector.x = vector.x / height * (height - contCorrect * 2) + contCorrect / height;
          }
        }

        // Set UVs using BufferGeometry API
        const uvAttribute = this.movieGeometry.getAttribute('uv');
        const uvArray = uvAttribute.array;

        // Helper to set UVs for a face (4 vertices, 8 UV values starting at faceIndex*8)
        const setFaceUVs = (faceIndex, corners) => {
          const baseIdx = faceIndex * 8;
          // Vertex order for each face in BoxBufferGeometry: 0,1,2,3 -> corners[3],corners[2],corners[0],corners[1]

          uvArray[baseIdx] = corners[3].x; uvArray[baseIdx + 1] = corners[3].y;
          uvArray[baseIdx + 2] = corners[2].x; uvArray[baseIdx + 3] = corners[2].y;
          uvArray[baseIdx + 4] = corners[0].x; uvArray[baseIdx + 5] = corners[0].y;
          uvArray[baseIdx + 6] = corners[1].x; uvArray[baseIdx + 7] = corners[1].y;
        };

        // Set UVs for each face - EAC has different face mapping
        setFaceUVs(0, right); // +X face
        setFaceUVs(1, left); // -X face
        setFaceUVs(2, top); // +Y face
        setFaceUVs(3, bottom); // -Y face
        setFaceUVs(4, front); // +Z face
        setFaceUVs(5, back); // -Z face

        uvAttribute.needsUpdate = true;

        this.movieScreen = new THREE.Mesh(this.movieGeometry, this.movieMaterial);
        this.movieScreen.position.set(position.x, position.y, position.z);
        this.movieScreen.rotation.y = -Math.PI;
        return this.movieScreen;
      };

      if (projection === 'EAC') {
        this.scene.add(makeScreen(new THREE.Matrix3(), new THREE.Matrix3()));
      } else {
        // EAC_LR: Stereo equi-angular cubemap
        const scaleMatrix = new THREE.Matrix3().set(
          0, 0.5, 0,
          1, 0, 0,
          0, 0, 1
        );

        // Left eye mesh
        this.movieScreenLeft = makeScreen(new THREE.Matrix3().set(
          0, -0.5, 0.5,
          1, 0, 0,
          0, 0, 1
        ), scaleMatrix);
        this.movieScreenLeft.layers.set(1); // Left eye only
        this.scene.add(this.movieScreenLeft);

        // Right eye mesh
        this.movieScreenRight = makeScreen(new THREE.Matrix3().set(
          0, -0.5, 1,
          1, 0, 0,
          0, 0, 1
        ), scaleMatrix);
        this.movieScreenRight.layers.set(2); // Right eye only
        this.scene.add(this.movieScreenRight);

        // Store reference for cleanup
        this.movieScreen = this.movieScreenLeft;
      }
    } else if (projection === 'SBS_MONO') {
      // SBS_MONO: Flat screen projection for side-by-side video
      // In WebXR: Left half in left eye, right half in right eye (stereo)
      // In browser: Left half only (mono)
      const distance = 3;

      // Get video dimensions - half width for SBS
      const video = this.getVideoEl_();
      const videoWidth = video.videoWidth / 2; // Half width
      const videoHeight = video.videoHeight;
      const videoAspect = videoWidth / videoHeight;

      // Calculate viewport dimensions at distance
      const fov = this.camera.fov * Math.PI / 180;
      const viewportHeight = 2 * distance * Math.tan(fov / 2);
      const viewportWidth = viewportHeight * this.camera.aspect;
      const viewportAspect = viewportWidth / viewportHeight;

      // Aspect fit: scale to fit inside viewport while maintaining aspect ratio
      let planeWidth; let planeHeight;

      if (videoAspect > viewportAspect) {
        // Video is wider - fit to width
        planeWidth = viewportWidth;
        planeHeight = viewportWidth / videoAspect;
      } else {
        // Video is taller - fit to height
        planeHeight = viewportHeight;
        planeWidth = viewportHeight * videoAspect;
      }

      // Check if we're in WebXR mode
      const isInWebXR = this.renderer && this.renderer.xr && this.renderer.xr.isPresenting;

      if (isInWebXR) {
        // WebXR mode: Create two separate meshes for left and right eyes
        // Left eye mesh (layer 1) - shows left half of video
        const leftGeometry = new THREE.PlaneBufferGeometry(planeWidth, planeHeight);
        const leftUvAttribute = leftGeometry.getAttribute('uv');
        const leftUvArray = leftUvAttribute.array;

        for (let i = 0; i < leftUvArray.length; i += 2) {
          leftUvArray[i] *= 0.5; // U: 0 to 0.5 (left half)
        }
        leftUvAttribute.needsUpdate = true;

        const leftMaterial = new THREE.MeshBasicMaterial({
          map: this.videoTexture,
          side: THREE.FrontSide
        });

        this.movieScreenLeft = new THREE.Mesh(leftGeometry, leftMaterial);
        this.movieScreenLeft.position.set(0, 0, -distance);
        this.movieScreenLeft.layers.set(1); // Only visible to left eye
        this.scene.add(this.movieScreenLeft);

        // Right eye mesh (layer 2) - shows right half of video
        const rightGeometry = new THREE.PlaneBufferGeometry(planeWidth, planeHeight);
        const rightUvAttribute = rightGeometry.getAttribute('uv');
        const rightUvArray = rightUvAttribute.array;

        for (let i = 0; i < rightUvArray.length; i += 2) {
          rightUvArray[i] = 0.5 + rightUvArray[i] * 0.5; // U: 0.5 to 1.0 (right half)
        }
        rightUvAttribute.needsUpdate = true;

        const rightMaterial = new THREE.MeshBasicMaterial({
          map: this.videoTexture,
          side: THREE.FrontSide
        });

        this.movieScreenRight = new THREE.Mesh(rightGeometry, rightMaterial);
        this.movieScreenRight.position.set(0, 0, -distance);
        this.movieScreenRight.layers.set(2); // Only visible to right eye
        this.scene.add(this.movieScreenRight);

        // Store reference for cleanup
        this.movieScreen = this.movieScreenLeft;
        this.movieGeometry = leftGeometry;
        this.movieMaterial = leftMaterial;
      } else {
        // Browser mode: Show left half only (mono)
        this.movieGeometry = new THREE.PlaneBufferGeometry(planeWidth, planeHeight);

        // Map UVs to left half of video only (U: 0 to 0.5)
        const uvAttribute = this.movieGeometry.getAttribute('uv');
        const uvArray = uvAttribute.array;

        for (let i = 0; i < uvArray.length; i += 2) {
          uvArray[i] *= 0.5; // Left half only
        }
        uvAttribute.needsUpdate = true;

        this.movieMaterial = new THREE.MeshBasicMaterial({
          map: this.videoTexture,
          side: THREE.FrontSide
        });

        this.movieScreen = new THREE.Mesh(this.movieGeometry, this.movieMaterial);
        this.movieScreen.position.set(0, 0, -distance);

        this.movieScreen.layers.enable(0);
        this.movieScreen.layers.enable(1);
        this.movieScreen.layers.enable(2);

        this.scene.add(this.movieScreen);
      }

      // Reset camera rotation to look straight ahead at centered plane
      this.camera.rotation.set(0, 0, 0);
      this.camera.lookAt(0, 0, -distance);

      this.sbsMonoActive_ = true;
    }

    this.currentProjection_ = projection;

  }

  triggerError_(errorObj) {
    // if we have videojs-errors use it
    if (this.videojsErrorsSupport_) {
      this.player_.error(errorObj);
    // if we don't have videojs-errors just use a normal player error
    } else {
      // strip any html content from the error message
      // as it is not supported outside of videojs-errors
      const div = document.createElement('div');

      div.innerHTML = errors[errorObj.code].message;

      const message = div.textContent || div.innerText || '';

      this.player_.error({
        code: errorObj.code,
        message
      });
    }
  }

  log(...msgs) {
    if (!this.options_.debug) {
      return;
    }

    msgs.forEach((msg) => {
      videojs.log('VR: ', msg);
    });
  }

  handleVrDisplayActivate_() {
    if (!this.vrDisplay) {
      return;
    }
    this.vrDisplay.requestPresent([{source: this.renderedCanvas}]).then(() => {
      if (!this.vrDisplay.cardboardUI_ || !videojs.browser.IS_IOS) {
        return;
      }

      // webvr-polyfill/cardboard ui only watches for click events
      // to tell that the back arrow button is pressed during cardboard vr.
      // but somewhere along the line these events are silenced with preventDefault
      // but only on iOS, so we translate them ourselves here
      let touches = [];
      const iosCardboardTouchStart_ = (e) => {
        for (let i = 0; i < e.touches.length; i++) {
          touches.push(e.touches[i]);
        }
      };

      const iosCardboardTouchEnd_ = (e) => {
        if (!touches.length) {
          return;
        }

        touches.forEach((t) => {
          const simulatedClick = new window.MouseEvent('click', {
            screenX: t.screenX,
            screenY: t.screenY,
            clientX: t.clientX,
            clientY: t.clientY
          });

          this.renderedCanvas.dispatchEvent(simulatedClick);
        });

        touches = [];
      };

      this.renderedCanvas.addEventListener('touchstart', iosCardboardTouchStart_);
      this.renderedCanvas.addEventListener('touchend', iosCardboardTouchEnd_);

      this.iosRevertTouchToClick_ = () => {
        this.renderedCanvas.removeEventListener('touchstart', iosCardboardTouchStart_);
        this.renderedCanvas.removeEventListener('touchend', iosCardboardTouchEnd_);
        this.iosRevertTouchToClick_ = null;
      };
    });
  }

  handleVrDisplayDeactivate_() {
    if (!this.vrDisplay || !this.vrDisplay.isPresenting) {
      return;
    }
    if (this.iosRevertTouchToClick_) {
      this.iosRevertTouchToClick_();
    }
    this.vrDisplay.exitPresent();

  }

  requestAnimationFrame(fn) {
    if (this.vrDisplay) {
      return this.vrDisplay.requestAnimationFrame(fn);
    }

    // Use window.requestAnimationFrame directly to ensure the render loop
    // continues even when the video player is paused or in certain states
    return window.requestAnimationFrame(fn);
  }

  cancelAnimationFrame(id) {
    if (this.vrDisplay) {
      return this.vrDisplay.cancelAnimationFrame(id);
    }

    return window.cancelAnimationFrame(id);
  }

  togglePlay_() {
    if (this.player_.paused()) {
      this.player_.play();
    } else {
      this.player_.pause();
    }
  }

  animate_(timestamp, xrFrame) {
    if (!this.initialized_) {
      return;
    }

    // Update video texture when video has any frame data (readyState >= 2)
    // HAVE_CURRENT_DATA (2), HAVE_FUTURE_DATA (3), or HAVE_ENOUGH_DATA (4)
    const videoEl = this.getVideoEl_();

    if (videoEl && videoEl.readyState >= videoEl.HAVE_CURRENT_DATA) {
      if (this.videoTexture) {
        // Ensure texture's image reference is current video element
        // This handles cases where video element may have been recreated
        if (this.videoTexture.image !== videoEl) {
          this.videoTexture.image = videoEl;
        }
        this.videoTexture.needsUpdate = true;
      }
    }

    // Only update controls if they exist
    if (this.controls3d) {
      this.controls3d.update();
    }
    if (this.omniController) {
      this.omniController.update(this.camera);
    }

    // Update VR HUD and Gallery
    if (this.vrHUD) {
      this.vrHUD.update();
    }
    if (this.vrGallery) {
      this.vrGallery.update();
    }

    // For WebXR, use the renderer directly; for legacy, use VREffect
    if (this.webXRSupported_ && this.renderer.xr.isPresenting) {
      this.renderer.render(this.scene, this.camera);
    } else {
      this.effect.render(this.scene, this.camera);
    }

    if (window.navigator.getGamepads) {
      // Grab all gamepads
      const gamepads = window.navigator.getGamepads();

      for (let i = 0; i < gamepads.length; ++i) {
        const gamepad = gamepads[i];

        // Make sure gamepad is defined
        // Only take input if state has changed since we checked last
        if (!gamepad || !gamepad.timestamp || gamepad.timestamp === this.prevTimestamps_[i]) {
          continue;
        }
        for (let j = 0; j < gamepad.buttons.length; ++j) {
          if (gamepad.buttons[j].pressed) {
            this.togglePlay_();
            this.prevTimestamps_[i] = gamepad.timestamp;
            break;
          }
        }
      }
    }
    this.camera.getWorldDirection(this.cameraVector);

    // If using setAnimationLoop (WebXR), don't call requestAnimationFrame manually
    if (!this.useSetAnimationLoop_) {
      this.animationFrameId_ = this.requestAnimationFrame(this.animate_);
    }
  }

  handleResize_() {
    // Skip resize if in XR session - XR controls the size
    if (this.renderer && this.renderer.xr && this.renderer.xr.isPresenting) {
      return;
    }

    const width = this.player_.currentWidth();
    const height = this.player_.currentHeight();

    this.effect.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setProjection(projection) {

    if (!utils.getInternalProjectionName(projection)) {
      videojs.log.error('videojs-vr: please pass a valid projection ' + utils.validProjections.join(', '));
      return;
    }

    this.currentProjection_ = projection;
    this.defaultProjection_ = projection;

    // Update VR HUD's projection state to keep UI in sync
    if (this.vrHUD) {
      this.vrHUD.setProjection(projection);
    }

    // If we're in an XR session, rebuild the geometry with the new projection
    if (this.renderer && this.renderer.xr && this.renderer.xr.isPresenting && this.scene) {
      this.log('Rebuilding projection during XR session:', projection);

      // Remove existing movie screen(s)
      const toRemove = [];

      this.scene.traverse((object) => {
        if (object.isMesh && object.material && object.material.map === this.videoTexture) {
          toRemove.push(object);
        }
      });
      toRemove.forEach(obj => {
        if (obj.parent) {
          obj.parent.remove(obj);
        }
        if (obj.geometry) {
          obj.geometry.dispose();
        }
        if (obj.material) {
          obj.material.dispose();
        }
      });

      // Create new video texture if needed
      if (!this.videoTexture) {
        this.videoTexture = new THREE.VideoTexture(this.getVideoEl_());
        this.videoTexture.generateMipmaps = false;
        this.videoTexture.minFilter = THREE.LinearFilter;
        this.videoTexture.magFilter = THREE.LinearFilter;
        this.videoTexture.format = THREE.RGBFormat;
      }

      // Rebuild the mesh with new projection
      this.changeProjection_(projection);

      // Add new movie screen to scene
      if (this.movieScreen) {
        this.scene.add(this.movieScreen);
      }

      // Reapply force mono if it was enabled (meshes were just recreated)
      if (this.forceMonoEnabled) {
        this.originalLayerStates_ = null; // Clear old states
        this.applyForceMonoProjection_();
      }

      // Ensure VR HUD and Gallery have proper layers after projection change
      if (this.vrHUD && this.vrHUD.refreshLayers) {
        this.vrHUD.refreshLayers();
      }
      if (this.vrGallery && this.vrGallery.refreshLayers) {
        this.vrGallery.refreshLayers();
      }

      this.log('Projection rebuilt successfully');
    }
  }

  /**
   * Apply force mono projection - uses left eye for both eyes in HMD
   * This makes the left eye mesh visible to BOTH eyes in VR (layers 1 and 2)
   * and hides the right eye mesh, so both eyes see the left half of stereo content
   */
  applyForceMonoProjection_() {
    if (!this.renderer || !this.renderer.xr || !this.renderer.xr.isPresenting) {
      return;
    }

    if (!this.scene) {
      return;
    }

    this.log('Force Mono:', this.forceMonoEnabled ? 'ENABLING' : 'DISABLING');

    // Use stored mesh references for SBS stereo content
    const leftMesh = this.movieScreenLeft;
    const rightMesh = this.movieScreenRight;

    if (leftMesh && rightMesh) {
      // SBS stereo mode - use direct mesh references
      this.log('Using stored SBS mesh references');

      if (this.forceMonoEnabled) {
        // Make left eye mesh visible to BOTH eyes using .set() for definitive assignment
        // .set() clears all layers first then enables the specified one
        leftMesh.layers.set(1);
        leftMesh.layers.enable(2); // Add layer 2 for right eye
        // Hide right eye mesh completely - set to layer 0 only (not visible in VR)
        rightMesh.layers.set(0);
        this.log('Mono enabled: left mesh on layers 1+2, right mesh on layer 0');
      } else {
        // Restore stereoscopic - use .set() for definitive layer assignment
        // This immediately sets the layer mask without any race conditions
        leftMesh.layers.set(1); // Left eye only
        rightMesh.layers.set(2); // Right eye only
        this.log('Stereo restored: left on layer 1, right on layer 2');
      }

      // Force material update to ensure rendering reflects the layer changes
      if (leftMesh.material) leftMesh.material.needsUpdate = true;
      if (rightMesh.material) rightMesh.material.needsUpdate = true;

    } else if (this.movieScreen) {
      // Non-SBS mode (360, 180, flat) - single mesh
      this.log('Using single movieScreen mesh');

      if (this.forceMonoEnabled) {
        // Ensure visible to both eyes
        this.movieScreen.layers.set(0);
        this.movieScreen.layers.enable(1);
        this.movieScreen.layers.enable(2);
        this.log('Mono enabled: movieScreen on all layers');
      } else {
        // Same for non-stereo content
        this.movieScreen.layers.set(0);
        this.movieScreen.layers.enable(1);
        this.movieScreen.layers.enable(2);
        this.log('Stereo mode: movieScreen on all layers (non-stereo content)');
      }

      // Force material update
      if (this.movieScreen.material) this.movieScreen.material.needsUpdate = true;
    } else {
      this.log('No video meshes found - nothing to toggle');
    }

    // Ensure VR HUD maintains proper layer visibility after any mono/stereo change
    if (this.vrHUD && this.vrHUD.refreshLayers) {
      this.vrHUD.refreshLayers();
    }
  }

  init() {
    // If we're in an XR session, don't do a full reset - just update the video texture
    // This allows seamless video source changes while in VR
    if (this.renderer && this.renderer.xr && this.renderer.xr.isPresenting) {
      this.log('Source changed during XR session - updating video texture without reset');
      // Create new video texture from updated video element
      const oldVideoTexture = this.videoTexture;

      this.videoTexture = new THREE.VideoTexture(this.getVideoEl_());
      this.videoTexture.generateMipmaps = false;
      this.videoTexture.minFilter = THREE.LinearFilter;
      this.videoTexture.magFilter = THREE.LinearFilter;
      this.videoTexture.format = THREE.RGBFormat;

      // Update ALL materials in the scene using video texture (both eyes in stereo modes)
      // This ensures both left and right eye meshes get the new texture
      this.scene.traverse((object) => {
        if (object.isMesh && object.material && object.material.map === oldVideoTexture) {
          object.material.map = this.videoTexture;
          object.material.needsUpdate = true;
          // Also clear baseQuaternion so orientation tracking starts fresh
          delete object.userData.baseQuaternion;
        }
      });

      // Dispose old texture after updating all references
      if (oldVideoTexture) {
        oldVideoTexture.dispose();
      }

      // Reapply force mono if it was enabled (mesh layer masks are preserved)
      // Clear stored states so they get recaptured with new texture references
      if (this.forceMonoEnabled) {
        this.originalLayerStates_ = null;
        this.applyForceMonoProjection_();
      }

      // Ensure VR HUD and Gallery have proper layers after video source change
      if (this.vrHUD && this.vrHUD.refreshLayers) {
        this.vrHUD.refreshLayers();
      }
      if (this.vrGallery && this.vrGallery.refreshLayers) {
        this.vrGallery.refreshLayers();
      }

      return;
    }

    this.reset();

    this.camera = new THREE.PerspectiveCamera(75, this.player_.currentWidth() / this.player_.currentHeight(), 1, 1000);
    // Store vector representing the direction in which the camera is looking, in world space.
    this.cameraVector = new THREE.Vector3();

    if (this.currentProjection_ === '360_LR' || this.currentProjection_ === '360_TB' || this.currentProjection_ === '180' || this.currentProjection_ === '180_LR' || this.currentProjection_ === '180_MONO' || this.currentProjection_ === 'EAC_LR') {
      // Render left eye when not in VR mode
      this.camera.layers.enable(1);
    }

    this.scene = new THREE.Scene();
    this.videoTexture = new THREE.VideoTexture(this.getVideoEl_());

    // shared regardless of wether VideoTexture is used or
    // an image canvas is used
    this.videoTexture.generateMipmaps = false;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoTexture.format = THREE.RGBFormat;

    // Handle poster image - show poster until video starts playing
    this.posterTexture = null;
    this.usingPoster = false;
    const posterUrl = this.player_.poster();

    if (posterUrl && !this.player_.hasStarted()) {
      // Load poster image as texture
      const textureLoader = new THREE.TextureLoader();

      textureLoader.load(
        posterUrl,
        (texture) => {
          this.posterTexture = texture;
          this.posterTexture.minFilter = THREE.LinearFilter;
          this.posterTexture.magFilter = THREE.LinearFilter;
          this.usingPoster = true;

          // Update ALL video materials to use poster (for stereo modes with multiple meshes)
          this.scene.traverse((object) => {
            if (object.isMesh && object.material && object.material.map === this.videoTexture) {
              object.material.map = this.posterTexture;
              object.material.needsUpdate = true;
            }
          });
        },
        undefined,
        (error) => {
          this.log('Failed to load poster image:', error);
        }
      );

      // Switch to video texture when video starts playing
      this.player_.one('playing', () => {
        if (this.usingPoster) {
          // Update ALL video materials back to video texture (for stereo modes)
          this.scene.traverse((object) => {
            if (object.isMesh && object.material && object.material.map === this.posterTexture) {
              object.material.map = this.videoTexture;
              object.material.needsUpdate = true;
            }
          });
          this.usingPoster = false;
        }
      });
    }

    this.changeProjection_(this.currentProjection_);

    if (this.currentProjection_ === 'NONE') {
      this.log('Projection is NONE, dont init');
      this.reset();
      return;
    }

    // SBS_MONO uses the 3D renderer with a flat plane, so it continues with normal init
    // The changeProjection_ method handles creating the proper geometry with UV mapping

    this.player_.removeChild('BigPlayButton');
    this.player_.addChild('BigVrPlayButton', {}, this.bigPlayButtonIndex_);
    this.player_.bigPlayButton = this.player_.getChild('BigVrPlayButton');

    // mobile devices, or cardboard forced to on
    if (this.options_.forceCardboard ||
        videojs.browser.IS_ANDROID ||
        videojs.browser.IS_IOS) {
      this.addCardboardButton_();
    }

    // if ios remove full screen toggle
    if (videojs.browser.IS_IOS && this.player_.controlBar && this.player_.controlBar.fullscreenToggle) {
      this.player_.controlBar.fullscreenToggle.hide();
    }

    this.camera.position.set(0, 0, 0);
    this.renderer = new THREE.WebGLRenderer({
      devicePixelRatio: window.devicePixelRatio,
      alpha: false,
      clearColor: 0xffffff,
      antialias: true
    });

    const webglContext = this.renderer.getContext('webgl');
    const oldTexImage2D = webglContext.texImage2D;

    /* this is a workaround since threejs uses try catch */
    webglContext.texImage2D = (...args) => {
      try {
        return oldTexImage2D.apply(webglContext, args);
      } catch (e) {
        this.reset();
        this.player_.pause();
        this.triggerError_({code: 'web-vr-hls-cors-not-supported', dismiss: false});
        throw new Error(e);
      }
    };

    this.renderer.setSize(this.player_.currentWidth(), this.player_.currentHeight(), false);
    this.effect = new VREffect(this.renderer);

    this.effect.setSize(this.player_.currentWidth(), this.player_.currentHeight(), false);
    this.vrDisplay = null;

    // Previous timestamps for gamepad updates
    this.prevTimestamps_ = [];

    this.renderedCanvas = this.renderer.domElement;
    this.renderedCanvas.setAttribute('style', 'width: 100%; height: 100%; position: absolute; top:0;');

    const videoElStyle = this.getVideoEl_().style;

    this.player_.el().insertBefore(this.renderedCanvas, this.player_.el().firstChild);

    // Hide video and show canvas for 3D rendering (including SBS_MONO which now uses 3D renderer)
    videoElStyle.zIndex = '-1';
    videoElStyle.opacity = '0';

    // Check for WebXR support first (modern API), then fall back to legacy WebVR
    const hasWebXR = navigator.xr && navigator.xr.isSessionSupported;
    const hasWebVR = window.navigator.getVRDisplays;

    const initializeControls = () => {
      // Skip orbit controls for SBS_MONO - it's a flat plane view with fixed camera
      if (!this.controls3d && this.currentProjection_ !== 'SBS_MONO') {
        this.log('no HMD found Using Orbit & Orientation Controls');
        const options = {
          camera: this.camera,
          canvas: this.renderedCanvas,
          // check if its a half sphere view projection
          halfView: this.currentProjection_.indexOf('180') === 0,
          orientation: videojs.browser.IS_IOS || videojs.browser.IS_ANDROID || false
        };

        if (this.options_.motionControls === false) {
          options.orientation = false;
        }

        this.controls3d = new OrbitOrientationContols(options);
        this.canvasPlayerControls = new CanvasPlayerControls(this.player_, this.renderedCanvas, this.options_);
      } else if (this.currentProjection_ === 'SBS_MONO') {
        this.log('SBS_MONO mode: flat plane view, no orbit controls needed');
      }

      // Initialize VR HUD if enabled
      if (this.options_.enableVRHUD) {
        this.initVRHUD_();
      }

      // Initialize VR Gallery if enabled
      if (this.options_.enableVRGallery) {
        this.initVRGallery_();
      }

      // Link VR HUD and VR Gallery for joystick scrolling and relative positioning
      if (this.vrHUD && this.vrGallery) {
        this.vrHUD.vrGallery = this.vrGallery;
        this.vrGallery.vrHUD = this.vrHUD;
      }

      // Use setAnimationLoop for WebXR compatibility
      if (this.webXRSupported_) {
        this.useSetAnimationLoop_ = true;
        this.renderer.setAnimationLoop(this.animate_);
      } else {
        this.useSetAnimationLoop_ = false;
        this.animationFrameId_ = this.requestAnimationFrame(this.animate_);
      }
    };

    if (hasWebXR) {
      this.log('WebXR is supported, checking for immersive-vr session support');
      navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
        if (supported) {
          this.log('WebXR immersive-vr is supported, adding cardboard button');
          this.addCardboardButton_();
          this.webXRSupported_ = true;
          // Enable WebXR on THREE.js renderer
          this.renderer.xr.enabled = true;
        } else {
          this.log('WebXR immersive-vr not supported on this device');
        }
        initializeControls();
      }).catch((err) => {
        this.log('WebXR check failed:', err);
        initializeControls();
      });
    } else if (hasWebVR) {
      this.log('Legacy WebVR is supported, getting vr displays');
      window.navigator.getVRDisplays().then((displays) => {
        if (displays.length > 0) {
          this.log('Displays found', displays);
          this.vrDisplay = displays[0];

          // Native WebVR Head Mounted Displays (HMDs) like the HTC Vive
          // also need the cardboard button to enter fully immersive mode
          // so, we want to add the button if we're not polyfilled.
          if (!this.vrDisplay.isPolyfilled) {
            this.log('Real HMD found using VRControls', this.vrDisplay);
            this.addCardboardButton_();

            // We use VRControls here since we are working with an HMD
            // and we only want orientation controls.
            this.controls3d = new VRControls(this.camera);
          }
        }
        initializeControls();
      });
    } else if (window.navigator.getVRDevices) {
      this.triggerError_({code: 'web-vr-out-of-date', dismiss: false});
      initializeControls();
    } else {
      this.log('No WebXR or WebVR support detected');
      initializeControls();
    }

    if (this.options_.omnitone) {
      const audiocontext = THREE.AudioContext.getContext();

      this.omniController = new OmnitoneController(
        audiocontext,
        this.options_.omnitone, this.getVideoEl_(), this.options_.omnitoneOptions
      );
      this.omniController.one('audiocontext-suspended', () => {
        this.player.pause();
        this.player.one('playing', () => {
          audiocontext.resume();
        });
      });
    }

    this.on(this.player_, 'fullscreenchange', this.handleResize_);
    window.addEventListener('vrdisplaypresentchange', this.handleResize_, true);
    window.addEventListener('resize', this.handleResize_, true);
    window.addEventListener('vrdisplayactivate', this.handleVrDisplayActivate_, true);
    window.addEventListener('vrdisplaydeactivate', this.handleVrDisplayDeactivate_, true);

    this.initialized_ = true;
    this.trigger('initialized');

    // Trigger resize after a short delay to ensure DOM is fully laid out
    // This fixes issues with aspect ratio when player dimensions aren't ready at init time
    setTimeout(() => {
      this.handleResize_();
    }, 100);
  }

  addCardboardButton_() {
    if (!this.player_.controlBar.getChild('CardboardButton')) {
      this.player_.controlBar.addChild('CardboardButton', {});
    }
  }

  getVideoEl_() {
    return this.player_.el().getElementsByTagName('video')[0];
  }

  reset() {
    if (!this.initialized_) {
      return;
    }

    // Clear SBS_MONO flag if active (3D cleanup is handled by scene removal below)
    if (this.sbsMonoActive_) {
      this.sbsMonoActive_ = false;
    }

    if (this.omniController) {
      this.omniController.off('audiocontext-suspended');
      this.omniController.dispose();
      this.omniController = undefined;
    }

    if (this.controls3d) {
      this.controls3d.dispose();
      this.controls3d = null;
    }

    if (this.canvasPlayerControls) {
      this.canvasPlayerControls.dispose();
      this.canvasPlayerControls = null;
    }

    // Dispose VR HUD and Gallery
    if (this.vrHUD) {
      this.vrHUD.dispose();
      this.vrHUD = null;
    }

    if (this.vrGallery) {
      this.vrGallery.dispose();
      this.vrGallery = null;
    }

    if (this.effect) {
      this.effect.dispose();
      this.effect = null;
    }

    window.removeEventListener('resize', this.handleResize_, true);
    window.removeEventListener('vrdisplaypresentchange', this.handleResize_, true);
    window.removeEventListener('vrdisplayactivate', this.handleVrDisplayActivate_, true);
    window.removeEventListener('vrdisplaydeactivate', this.handleVrDisplayDeactivate_, true);

    // re-add the big play button to player
    if (!this.player_.getChild('BigPlayButton')) {
      this.player_.addChild('BigPlayButton', {}, this.bigPlayButtonIndex_);
    }

    if (this.player_.getChild('BigVrPlayButton')) {
      this.player_.removeChild('BigVrPlayButton');
    }

    // remove the cardboard button
    if (this.player_.getChild('CardboardButton')) {
      this.player_.controlBar.removeChild('CardboardButton');
    }

    // show the fullscreen again
    if (videojs.browser.IS_IOS && this.player_.controlBar && this.player_.controlBar.fullscreenToggle) {
      this.player_.controlBar.fullscreenToggle.show();
    }

    // reset the video element style so that it will be displayed
    const videoElStyle = this.getVideoEl_().style;

    videoElStyle.zIndex = '';
    videoElStyle.opacity = '';

    // set the current projection to the default
    this.currentProjection_ = this.defaultProjection_;

    // Initialize force mono state (persists for VR session)
    this.forceMonoEnabled = false;
    this.originalProjection_ = null;

    // reset the ios touch to click workaround
    if (this.iosRevertTouchToClick_) {
      this.iosRevertTouchToClick_();
    }

    // remove the old canvas
    if (this.renderedCanvas) {
      this.renderedCanvas.parentNode.removeChild(this.renderedCanvas);
    }

    // Stop the animation loop
    if (this.useSetAnimationLoop_ && this.renderer) {
      this.renderer.setAnimationLoop(null);
    }
    if (this.animationFrameId_) {
      this.cancelAnimationFrame(this.animationFrameId_);
    }

    // End any active XR session
    if (this.xrSession_) {
      this.xrSession_.end().catch(() => {});
      this.xrSession_ = null;
    }

    this.initialized_ = false;
  }

  /**
   * Initialize VR HUD with controls
   */
  initVRHUD_() {
    this.vrHUD = new VRHUD({
      player: this.player_,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      hudHeight: this.options_.hudHeight,
      hudScale: this.options_.hudScale,
      hudDistance: this.options_.hudDistance,
      onNext: () => {
        if (this.options_.onNext) {
          this.options_.onNext();
        }
        this.trigger('vr-next');
      },
      onPrevious: () => {
        if (this.options_.onPrevious) {
          this.options_.onPrevious();
        }
        this.trigger('vr-previous');
      },
      onGallery: () => {
        console.log('[VR Plugin] onGallery called, vrGallery:', !!this.vrGallery);
        if (this.vrGallery) {
          this.vrGallery.toggle();
          console.log('[VR Plugin] Gallery toggled, now visible:', this.vrGallery.isVisible);
        } else {
          console.warn('[VR Plugin] vrGallery not available');
        }
        if (this.options_.onGallery) {
          this.options_.onGallery();
        }
        this.trigger('vr-gallery');
      },
      onExit: () => {
        if (this.options_.onExit) {
          this.options_.onExit();
        }
        this.trigger('vr-exit');
      },
      onProjectionChange: (projection) => {
        console.log('[VR Plugin] Projection change requested:', projection);
        this.setProjection(projection);
        if (this.options_.onProjectionChange) {
          this.options_.onProjectionChange(projection);
        }
        this.trigger('vr-projection-change', { projection });
      },
      onFavorite: this.options_.onFavorite ? () => {
        this.options_.onFavorite();
        this.trigger('vr-favorite');
      } : null,
      onForceMonoToggle: (enabled) => {
        // Handle force mono toggle - uses left eye for both eyes
        console.log('[VR Plugin] Force Mono toggle:', enabled);
        this.forceMonoEnabled = enabled;

        // Always apply the projection immediately, checking for meshes
        const leftMesh = this.movieScreenLeft;
        const rightMesh = this.movieScreenRight;

        if (leftMesh && rightMesh) {
          console.log('[VR Plugin] Found SBS meshes, applying layers');
          if (enabled) {
            // Mono: show left eye to both eyes
            leftMesh.layers.set(1);
            leftMesh.layers.enable(2);
            // Hide right mesh from both eyes
            rightMesh.layers.disableAll();
            console.log('[VR Plugin] Mono ON: left mesh on layers 1+2, right mesh hidden');
          } else {
            // Stereo: restore separate eyes - use disableAll first for clean state
            leftMesh.layers.disableAll();
            leftMesh.layers.enable(1);
            rightMesh.layers.disableAll();
            rightMesh.layers.enable(2);
            console.log('[VR Plugin] Mono OFF: left on layer 1 only, right on layer 2 only');
          }
          if (leftMesh.material) leftMesh.material.needsUpdate = true;
          if (rightMesh.material) rightMesh.material.needsUpdate = true;
        } else if (this.movieScreen) {
          // Non-SBS content - ensure visible to both eyes
          console.log('[VR Plugin] Using single movieScreen');
          this.movieScreen.layers.enableAll();
          if (this.movieScreen.material) this.movieScreen.material.needsUpdate = true;
        } else {
          console.warn('[VR Plugin] No video meshes found for mono toggle');
          // Try to rebuild projection if meshes are missing
          if (this.currentProjection_ === 'SBS_MONO' && this.renderer && this.renderer.xr && this.renderer.xr.isPresenting) {
            console.log('[VR Plugin] Rebuilding SBS_MONO to create stereo meshes');
            this.setProjection('SBS_MONO');
          }
        }

        // ALWAYS refresh VR HUD and Gallery layers to prevent double vision
        if (this.vrHUD && this.vrHUD.refreshLayers) {
          this.vrHUD.refreshLayers();
          console.log('[VR Plugin] VR HUD layers refreshed');
        }
        if (this.vrGallery && this.vrGallery.refreshLayers) {
          this.vrGallery.refreshLayers();
        }

        if (this.options_.onForceMonoToggle) {
          this.options_.onForceMonoToggle(enabled);
        }
        this.trigger('vr-force-mono', { enabled });
      },
      onOrientationChange: (euler) => {
        // For SBS_MONO (flat screen): translate the plane position in space
        // For other projections (360, 180, etc.): rotate the sphere/hemisphere
        const isSBS = this.currentProjection_ === 'SBS_MONO';

        if (isSBS) {
          // SBS mode: Move the 2D plane in space
          // This allows positioning the screen on ceiling for lying down viewing
          // euler.x (pitch): moves screen up/down (positive = up)
          // euler.y (yaw): moves screen left/right (positive = left)
          const distance = 3; // Base distance from camera

          // Use proper spherical coordinates to maintain constant distance from camera
          // regardless of pitch/yaw angle - screen stays on a sphere around the viewer
          const offsetX = -Math.sin(euler.y) * Math.cos(euler.x) * distance;
          const offsetY = Math.sin(euler.x) * distance;
          const offsetZ = -Math.cos(euler.y) * Math.cos(euler.x) * distance;

          // Apply position to both SBS meshes
          if (this.movieScreenLeft) {
            if (!this.movieScreenLeft.userData.basePosition) {
              this.movieScreenLeft.userData.basePosition = this.movieScreenLeft.position.clone();
            }
            this.movieScreenLeft.position.set(offsetX, offsetY, offsetZ);
            // Make the plane face the camera
            this.movieScreenLeft.lookAt(this.camera.position);
          }
          if (this.movieScreenRight) {
            if (!this.movieScreenRight.userData.basePosition) {
              this.movieScreenRight.userData.basePosition = this.movieScreenRight.position.clone();
            }
            this.movieScreenRight.position.set(offsetX, offsetY, offsetZ);
            // Make the plane face the camera
            this.movieScreenRight.lookAt(this.camera.position);
          }
          // Also handle single movieScreen for non-XR mode
          if (this.movieScreen && !this.movieScreenLeft) {
            if (!this.movieScreen.userData.basePosition) {
              this.movieScreen.userData.basePosition = this.movieScreen.position.clone();
            }
            this.movieScreen.position.set(offsetX, offsetY, offsetZ);
            this.movieScreen.lookAt(this.camera.position);
          }
        } else {
          // Non-SBS mode: Apply rotation to video meshes
          // Ensure YXZ order to prevent horizon roll - only yaw (left/right) and pitch (up/down)
          const safeEuler = new THREE.Euler(euler.x, euler.y, 0, 'YXZ');
          const offsetQuat = new THREE.Quaternion().setFromEuler(safeEuler);

          // Find all video screen meshes in the scene
          // Check BOTH for videoTexture AND posterTexture to handle both eyes
          this.scene.traverse((object) => {
            if (object.isMesh && object.material && object.material.map) {
              // Match video meshes by checking for either videoTexture or posterTexture
              const isVideoMesh = object.material.map === this.videoTexture ||
                                 (this.posterTexture && object.material.map === this.posterTexture);

              if (isVideoMesh) {
                // Get the base rotation (initial orientation)
                const baseQuat = new THREE.Quaternion();

                if (object.userData.baseQuaternion) {
                  baseQuat.copy(object.userData.baseQuaternion);
                } else {
                  // Store initial quaternion on first use
                  object.userData.baseQuaternion = object.quaternion.clone();
                  baseQuat.copy(object.quaternion);
                }

                // Apply offset rotation on top of base rotation
                object.quaternion.copy(baseQuat).multiply(offsetQuat);
              }
            }
          });
        }

        this.trigger('vr-orientation-change', euler);
      }
    });

    // Show HUD on start if configured
    if (this.options_.showHUDOnStart) {
      this.vrHUD.show();
    }

    // Auto-hide HUD after delay if configured
    if (this.options_.hudAutoHideDelay > 0) {
      this.setupHUDAutoHide_();
    }

    this.log('VR HUD initialized');
  }

  /**
   * Initialize VR Gallery
   */
  initVRGallery_() {
    // Pass getSrc directly - deduplication in viewer prevents infinite loops
    const getSrcFunc = this.options_.getSrc || null;

    if (getSrcFunc) {
      console.log('[VR Plugin] VR Gallery initialized with getSrc function');
    }

    this.vrGallery = new VRGallery({
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      getSrc: getSrcFunc,
      onMediaSelect: (item, index) => {
        console.log('[VR Gallery] Media selected:', item, index);
        if (this.options_.onMediaSelect) {
          this.options_.onMediaSelect(item, index);
        }
        this.trigger('vr-media-select', {item, index});
      }
    });

    // Set initial media items if provided
    if (this.options_.mediaItems && this.options_.mediaItems.length > 0) {
      this.vrGallery.setMediaItems(this.options_.mediaItems);
    }

    this.log('VR Gallery initialized');
  }

  /**
   * Setup auto-hide for HUD
   */
  setupHUDAutoHide_() {
    let hideTimer = null;

    const resetTimer = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
      }
      if (this.vrHUD && !this.vrHUD.isVisible) {
        this.vrHUD.show();
      }
      hideTimer = setTimeout(() => {
        if (this.vrHUD) {
          this.vrHUD.hide();
        }
      }, this.options_.hudAutoHideDelay);
    };

    // Reset timer on user activity
    this.on(this.player_, 'playing', resetTimer);
    this.on(this.player_, 'pause', () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
      }
      if (this.vrHUD) {
        this.vrHUD.show();
      }
    });

    if (this.renderedCanvas) {
      this.renderedCanvas.addEventListener('mousemove', resetTimer);
      this.renderedCanvas.addEventListener('click', resetTimer);
    }
  }

  /**
   * Show the VR HUD
   */
  showHUD() {
    if (this.vrHUD) {
      this.vrHUD.show();
    }
  }

  /**
   * Hide the VR HUD
   */
  hideHUD() {
    if (this.vrHUD) {
      this.vrHUD.hide();
    }
  }

  /**
   * Toggle the VR HUD visibility
   */
  toggleHUD() {
    if (this.vrHUD) {
      this.vrHUD.toggle();
    }
  }

  /**
   * Show the VR Gallery
   */
  showGallery() {
    if (this.vrGallery) {
      this.vrGallery.show();
    }
  }

  /**
   * Hide the VR Gallery
   */
  hideGallery() {
    if (this.vrGallery) {
      this.vrGallery.hide();
    }
  }

  /**
   * Toggle the VR Gallery visibility
   */
  toggleGallery() {
    if (this.vrGallery) {
      this.vrGallery.toggle();
    }
  }

  /**
   * Set the favorite state on the VR HUD
   *
   * @param {boolean} isFavorited - Whether the current video is favorited
   */
  setFavoriteState(isFavorited) {
    if (this.vrHUD) {
      this.vrHUD.setFavoriteState(isFavorited);
    }
  }

  /**
   * Get the current favorite state from the VR HUD
   *
   * @return {boolean} Whether the current video is favorited
   */
  getFavoriteState() {
    if (this.vrHUD) {
      return this.vrHUD.getFavoriteState();
    }
    return false;
  }

  /**
   * Set media items for the gallery
   *
   * @param {Array} items - Array of media items with thumbnail, title, url, etc.
   */
  setGalleryItems(items) {
    if (this.vrGallery) {
      this.vrGallery.setMediaItems(items);
    }
  }

  /**
   * Set orientation offset for lying down viewing, etc.
   *
   * @param {Object|THREE.Euler} offset - Orientation offset {x, y, z} or Euler
   */
  setOrientationOffset(offset) {
    if (this.controls3d && this.controls3d.setOrientationOffset) {
      this.controls3d.setOrientationOffset(offset);
    }
    if (this.vrHUD) {
      this.vrHUD.setOrientationOffset(offset);
    }
  }

  /**
   * Reset orientation offset to default
   */
  resetOrientationOffset() {
    if (this.controls3d && this.controls3d.resetOrientationOffset) {
      this.controls3d.resetOrientationOffset();
    }
    if (this.vrHUD) {
      this.vrHUD.setOrientationOffset({x: 0, y: 0, z: 0});
    }
  }

  /**
   * Recenter the VR view to current head position
   */
  recenter() {
    if (this.controls3d && this.controls3d.recenter) {
      this.controls3d.recenter();
    }
  }

  /**
   * Check if VR is currently presenting (in XR session or VR display)
   *
   * @return {boolean} True if currently in VR presentation mode
   */
  isPresenting() {
    // Check WebXR first
    if (this.webXRSupported_ && this.renderer && this.renderer.xr && this.renderer.xr.isPresenting) {
      return true;
    }
    // Check legacy VR display
    if (this.vrDisplay && this.vrDisplay.isPresenting) {
      return true;
    }
    return false;
  }

  dispose() {
    super.dispose();
    this.reset();
  }

  polyfillVersion() {
    return WebVRPolyfill.version;
  }
}

VR.prototype.setTimeout = Component.prototype.setTimeout;
VR.prototype.clearTimeout = Component.prototype.clearTimeout;

VR.VERSION = VERSION;

videojs.registerPlugin('vr', VR);
export default VR;

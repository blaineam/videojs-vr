import * as THREE from 'three';

/**
 * VR HUD - In-VR User Interface with modern controls
 * Provides scrub bar, navigation, and orientation controls
 * Only visible when in WebXR/HMD mode
 */
class VRHUD {
  constructor(options) {
    this.player = options.player;
    this.scene = options.scene;
    this.camera = options.camera;
    this.renderer = options.renderer;

    // Callbacks for navigation
    this.onNext = options.onNext || (() => {});
    this.onPrevious = options.onPrevious || (() => {});
    this.onOrientationChange = options.onOrientationChange || (() => {});
    this.onGallery = options.onGallery || (() => {});
    this.onExit = options.onExit || (() => {});

    // HUD configuration (can be overridden by options)
    this.hudDistance = options.hudDistance !== undefined ? options.hudDistance : 4;
    this.hudHeight = options.hudHeight !== undefined ? options.hudHeight : 1.5;
    this.hudScale = options.hudScale !== undefined ? options.hudScale : 0.015;
    this.autoHideDelay = options.autoHideDelay !== undefined ? options.autoHideDelay : 10000;

    // Interaction state
    this.isVisible = false; // Start hidden, only show in WebXR
    this.isInXRSession = false;
    this.hideTimeout = null;
    this.isDraggingOrientation = false;
    this.isDraggingScrub = false;

    // Orientation offset (for lying down viewing)
    this.orientationOffset = new THREE.Euler(0, 0, 0);

    // Raycaster for gaze/pointer interaction
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(0, 0); // Center of screen for gaze

    // Interactive elements for raycasting - must be initialized before create* methods
    this.interactiveElements = [];

    // Create HUD elements
    this.hudGroup = new THREE.Group();
    this.hudGroup.name = 'vr-hud';
    this.hudGroup.visible = false; // Start hidden

    this.createCursor();
    this.createControlPanel();
    this.createScrubBar();
    this.createNavigationButtons();

    this.scene.add(this.hudGroup);

    // Bind methods
    this.update = this.update.bind(this);
    this.onSelect = this.onSelect.bind(this);
    this.onSelectStart = this.onSelectStart.bind(this);
    this.onSelectEnd = this.onSelectEnd.bind(this);
    this.onSqueezeStart = this.onSqueezeStart.bind(this);
    this.onSqueezeEnd = this.onSqueezeEnd.bind(this);
    this.onXRSessionStart = this.onXRSessionStart.bind(this);
    this.onXRSessionEnd = this.onXRSessionEnd.bind(this);

    // Setup interaction listeners
    this.setupInteraction();

    // Listen for XR session changes
    this.setupXRListeners();
  }

  setupXRListeners() {
    // Only show HUD when in XR session
    if (this.renderer.xr) {
      this.renderer.xr.addEventListener('sessionstart', this.onXRSessionStart);
      this.renderer.xr.addEventListener('sessionend', this.onXRSessionEnd);
    }
  }

  onXRSessionStart() {
    this.isInXRSession = true;
    // Don't auto-show HUD - user must squeeze grip or use hand gesture
  }

  onXRSessionEnd() {
    this.isInXRSession = false;
    this.hide();
  }

  createCursor() {
    // Create a visible cursor/reticle for gaze interaction
    const cursorGeometry = new THREE.RingGeometry(0.01, 0.015, 32);
    const cursorMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      opacity: 0.8,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false
    });

    this.cursor = new THREE.Mesh(cursorGeometry, cursorMaterial);
    this.cursor.name = 'vr-cursor';

    // Inner dot
    const dotGeometry = new THREE.CircleGeometry(0.005, 16);
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      opacity: 0.9,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false
    });
    this.cursorDot = new THREE.Mesh(dotGeometry, dotMaterial);
    this.cursor.add(this.cursorDot);

    // Hover ring (expands when hovering over interactive element)
    const hoverGeometry = new THREE.RingGeometry(0.018, 0.022, 32);
    const hoverMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      opacity: 0,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false
    });
    this.cursorHover = new THREE.Mesh(hoverGeometry, hoverMaterial);
    this.cursor.add(this.cursorHover);

    // Position cursor in front of camera
    this.cursor.position.set(0, 0, -2);
    this.camera.add(this.cursor);
  }

  createControlPanel() {
    // Background panel for controls
    const panelWidth = 2.4;
    const panelHeight = 0.6;

    const panelGeometry = new THREE.PlaneGeometry(panelWidth, panelHeight);
    const panelMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1a2e,
      opacity: 0.85,
      transparent: true,
      side: THREE.DoubleSide
    });

    this.controlPanel = new THREE.Mesh(panelGeometry, panelMaterial);
    this.controlPanel.name = 'control-panel';
    this.controlPanel.position.set(0, 0, 0); // HUD group is positioned, panel is at origin within group
    // No rotation - panel is vertical like a wall facing the camera

    // Panel border/glow
    const borderGeometry = new THREE.PlaneGeometry(panelWidth + 0.02, panelHeight + 0.02);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      opacity: 0.3,
      transparent: true,
      side: THREE.DoubleSide
    });
    const border = new THREE.Mesh(borderGeometry, borderMaterial);
    border.position.z = -0.001;
    this.controlPanel.add(border);

    this.hudGroup.add(this.controlPanel);
  }

  createScrubBar() {
    const scrubGroup = new THREE.Group();
    scrubGroup.name = 'scrub-bar-group';

    // Track background
    const trackWidth = 1.8;
    const trackHeight = 0.08;

    const trackGeometry = new THREE.PlaneGeometry(trackWidth, trackHeight);
    const trackMaterial = new THREE.MeshBasicMaterial({
      color: 0x333344,
      opacity: 0.9,
      transparent: true
    });

    this.scrubTrack = new THREE.Mesh(trackGeometry, trackMaterial);
    this.scrubTrack.name = 'scrub-track';
    this.scrubTrack.userData.interactive = true;
    this.scrubTrack.userData.type = 'scrub';
    scrubGroup.add(this.scrubTrack);

    // Progress fill (removed - user wants only white circle, not blue bar)
    // const progressGeometry = new THREE.PlaneGeometry(0.01, trackHeight - 0.01);
    // const progressMaterial = new THREE.MeshBasicMaterial({
    //   color: 0x00ffff,
    //   opacity: 1
    // });
    //
    // this.scrubProgress = new THREE.Mesh(progressGeometry, progressMaterial);
    // this.scrubProgress.name = 'scrub-progress';
    // this.scrubProgress.position.x = -trackWidth / 2;
    // this.scrubProgress.position.z = 0.001;
    // scrubGroup.add(this.scrubProgress);

    // Scrub handle
    const handleGeometry = new THREE.CircleGeometry(0.06, 16);
    const handleMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      opacity: 1
    });

    this.scrubHandle = new THREE.Mesh(handleGeometry, handleMaterial);
    this.scrubHandle.name = 'scrub-handle';
    this.scrubHandle.position.x = -trackWidth / 2;
    this.scrubHandle.position.z = 0.002;
    this.scrubHandle.userData.interactive = true;
    this.scrubHandle.userData.type = 'scrub-handle';
    scrubGroup.add(this.scrubHandle);

    // Time display
    this.timeCanvas = document.createElement('canvas');
    this.timeCanvas.width = 256;
    this.timeCanvas.height = 64;
    this.timeContext = this.timeCanvas.getContext('2d');

    this.timeTexture = new THREE.CanvasTexture(this.timeCanvas);
    const timeMaterial = new THREE.MeshBasicMaterial({
      map: this.timeTexture,
      transparent: true
    });

    const timeGeometry = new THREE.PlaneGeometry(0.4, 0.1);
    this.timeDisplay = new THREE.Mesh(timeGeometry, timeMaterial);
    this.timeDisplay.position.set(0, -0.12, 0.001);
    scrubGroup.add(this.timeDisplay);

    scrubGroup.position.set(0, 0.1, 0.01);
    this.controlPanel.add(scrubGroup);

    this.interactiveElements.push(this.scrubTrack, this.scrubHandle);
    this.scrubTrackWidth = trackWidth;
  }

  createNavigationButtons() {
    const buttonGroup = new THREE.Group();
    buttonGroup.name = 'navigation-buttons';

    // Exit VR button (leftmost)
    this.exitBtn = this.createButton('✕', -0.9, -0.15, 'exit-vr', 0xff3366);
    buttonGroup.add(this.exitBtn);

    // Gallery button
    this.galleryBtn = this.createButton('⊞', -0.55, -0.15, 'gallery');
    buttonGroup.add(this.galleryBtn);

    // Previous button
    this.prevBtn = this.createButton('⏮', -0.25, -0.15, 'previous');
    buttonGroup.add(this.prevBtn);

    // Play/Pause button
    this.playPauseBtn = this.createButton('⏯', 0, -0.15, 'play-pause');
    buttonGroup.add(this.playPauseBtn);

    // Next button
    this.nextBtn = this.createButton('⏭', 0.25, -0.15, 'next');
    buttonGroup.add(this.nextBtn);

    // Orientation reset button
    this.orientResetBtn = this.createButton('⟲', 0.5, -0.15, 'reset-orientation');
    buttonGroup.add(this.orientResetBtn);

    // Orientation drag handle - aligned in row with other buttons
    this.orientDragBtn = this.createButton('✋', 0.75, -0.15, 'orientation-handle');
    buttonGroup.add(this.orientDragBtn);

    this.controlPanel.add(buttonGroup);
  }

  createButton(label, x, y, type, customColor) {
    const btnGroup = new THREE.Group();
    btnGroup.name = `btn-${type}`;

    // Button background
    const btnGeometry = new THREE.CircleGeometry(0.08, 32);
    const baseColor = customColor || 0x2a2a4a;
    const btnMaterial = new THREE.MeshBasicMaterial({
      color: baseColor,
      opacity: 0.9,
      transparent: true
    });

    const btnMesh = new THREE.Mesh(btnGeometry, btnMaterial);
    btnMesh.userData.interactive = true;
    btnMesh.userData.type = type;
    btnMesh.userData.baseColor = baseColor;
    btnMesh.userData.hoverColor = customColor ? 0xff6699 : 0x00ffff;
    btnGroup.add(btnMesh);

    // Button border
    const borderGeometry = new THREE.RingGeometry(0.075, 0.085, 32);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      opacity: 0.5,
      transparent: true
    });
    const border = new THREE.Mesh(borderGeometry, borderMaterial);
    border.position.z = 0.001;
    btnGroup.add(border);

    // Button label (using canvas texture)
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.font = '40px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 32, 32);

    const labelTexture = new THREE.CanvasTexture(canvas);
    const labelMaterial = new THREE.MeshBasicMaterial({
      map: labelTexture,
      transparent: true
    });
    const labelGeometry = new THREE.PlaneGeometry(0.1, 0.1);
    const labelMesh = new THREE.Mesh(labelGeometry, labelMaterial);
    labelMesh.position.z = 0.002;
    btnGroup.add(labelMesh);

    btnGroup.position.set(x, y, 0.01);

    this.interactiveElements.push(btnMesh);

    return btnGroup;
  }

  setupInteraction() {
    // For VR controllers and hands
    if (this.renderer.xr) {
      // Controller 0 (typically right hand on Quest)
      const controller0 = this.renderer.xr.getController(0);
      const controllerGrip0 = this.renderer.xr.getControllerGrip(0);
      const hand0 = this.renderer.xr.getHand(0);

      if (controller0) {
        controller0.addEventListener('selectstart', this.onSelectStart);
        controller0.addEventListener('selectend', this.onSelectEnd);
        controller0.addEventListener('select', this.onSelect);
        controller0.addEventListener('squeezestart', this.onSqueezeStart);
        controller0.addEventListener('squeezeend', this.onSqueezeEnd);

        // Create pointer ray visualization for controller 0
        const rayGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -5)
        ]);
        const rayMaterial = new THREE.LineBasicMaterial({
          color: 0x00ffff,
          opacity: 0.5,
          transparent: true,
          linewidth: 2
        });
        const ray = new THREE.Line(rayGeometry, rayMaterial);
        ray.name = 'controller-ray';
        ray.visible = false; // Only show when pointing at UI
        controller0.add(ray);

        // Add simple controller model visualization
        const controllerModel0 = this.createControllerModel();
        controllerGrip0.add(controllerModel0);

        this.scene.add(controller0);
        this.scene.add(controllerGrip0);

        // Store references
        this.controller0 = controller0;
        this.controllerGrip0 = controllerGrip0;
        this.ray0 = ray;
      }

      // Controller 1 (typically left hand on Quest)
      const controller1 = this.renderer.xr.getController(1);
      const controllerGrip1 = this.renderer.xr.getControllerGrip(1);
      const hand1 = this.renderer.xr.getHand(1);

      if (controller1) {
        controller1.addEventListener('selectstart', this.onSelectStart);
        controller1.addEventListener('selectend', this.onSelectEnd);
        controller1.addEventListener('select', this.onSelect);
        controller1.addEventListener('squeezestart', this.onSqueezeStart);
        controller1.addEventListener('squeezeend', this.onSqueezeEnd);

        // Create pointer ray visualization for controller 1
        const rayGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -5)
        ]);
        const rayMaterial = new THREE.LineBasicMaterial({
          color: 0x00ffff,
          opacity: 0.5,
          transparent: true,
          linewidth: 2
        });
        const ray = new THREE.Line(rayGeometry, rayMaterial);
        ray.name = 'controller-ray';
        ray.visible = false;
        controller1.add(ray);

        // Add simple controller model visualization
        const controllerModel1 = this.createControllerModel();
        controllerGrip1.add(controllerModel1);

        this.scene.add(controller1);
        this.scene.add(controllerGrip1);

        // Store references
        this.controller1 = controller1;
        this.controllerGrip1 = controllerGrip1;
        this.ray1 = ray;
      }

      // Setup hand tracking (Quest supports hand tracking)
      if (hand0) {
        hand0.addEventListener('pinchstart', this.onPinchStart.bind(this));
        hand0.addEventListener('pinchend', this.onPinchEnd.bind(this));

        // Add hand model visualization
        const handModel0 = this.createHandModel();
        hand0.add(handModel0);

        this.scene.add(hand0);
        this.hand0 = hand0;
      }

      if (hand1) {
        hand1.addEventListener('pinchstart', this.onPinchStart.bind(this));
        hand1.addEventListener('pinchend', this.onPinchEnd.bind(this));

        // Add hand model visualization
        const handModel1 = this.createHandModel();
        hand1.add(handModel1);

        this.scene.add(hand1);
        this.hand1 = hand1;
      }
    }

    // For mouse/touch in non-VR mode
    if (this.renderer.domElement) {
      this.renderer.domElement.addEventListener('click', (e) => {
        this.handleClick(e);
      });

      this.renderer.domElement.addEventListener('mousedown', (e) => {
        this.handleMouseDown(e);
      });

      this.renderer.domElement.addEventListener('mouseup', (e) => {
        this.handleMouseUp(e);
      });

      this.renderer.domElement.addEventListener('mousemove', (e) => {
        this.handleMouseMove(e);
      });
    }
  }

  handleClick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactiveElements);

    if (intersects.length > 0) {
      this.handleInteraction(intersects[0].object, intersects[0].point);
    }
  }

  handleMouseDown(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactiveElements);

    if (intersects.length > 0) {
      const obj = intersects[0].object;
      if (obj.userData.type === 'orientation-handle') {
        this.isDraggingOrientation = true;
        this.dragStartPoint = intersects[0].point.clone();
        this.dragStartRotation = this.orientationOffset.clone();
      } else if (obj.userData.type === 'scrub' || obj.userData.type === 'scrub-handle') {
        this.isDraggingScrub = true;
      }
    }
  }

  handleMouseUp(event) {
    this.isDraggingOrientation = false;
    this.isDraggingScrub = false;
  }

  handleMouseMove(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    if (this.isDraggingOrientation) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const intersects = this.raycaster.intersectObjects([this.controlPanel]);

      if (intersects.length > 0) {
        const currentPoint = intersects[0].point;
        const delta = currentPoint.clone().sub(this.dragStartPoint);

        // Update orientation offset
        this.orientationOffset.x = this.dragStartRotation.x + delta.y * 2;
        this.orientationOffset.y = this.dragStartRotation.y + delta.x * 2;

        // Clamp values
        this.orientationOffset.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.orientationOffset.x));

        this.onOrientationChange(this.orientationOffset);
      }
    }

    if (this.isDraggingScrub) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const intersects = this.raycaster.intersectObjects([this.scrubTrack]);

      if (intersects.length > 0) {
        const localPoint = this.scrubTrack.worldToLocal(intersects[0].point.clone());
        const progress = (localPoint.x + this.scrubTrackWidth / 2) / this.scrubTrackWidth;
        const clampedProgress = Math.max(0, Math.min(1, progress));

        if (this.player.duration()) {
          this.player.currentTime(this.player.duration() * clampedProgress);
        }
      }
    }
  }

  onSelectStart(event) {
    const controller = event.target;
    this.tempMatrix = new THREE.Matrix4();
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);

    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

    const intersects = this.raycaster.intersectObjects(this.interactiveElements);

    if (intersects.length > 0) {
      const obj = intersects[0].object;
      if (obj.userData.type === 'orientation-handle') {
        this.isDraggingOrientation = true;
        this.dragStartPoint = intersects[0].point.clone();
        this.dragStartRotation = this.orientationOffset.clone();
      } else if (obj.userData.type === 'scrub' || obj.userData.type === 'scrub-handle') {
        this.isDraggingScrub = true;
      }
    }
  }

  onSelectEnd(event) {
    this.isDraggingOrientation = false;
    this.isDraggingScrub = false;
  }

  onSelect(event) {
    const controller = event.target;
    this.tempMatrix = new THREE.Matrix4();
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);

    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

    // Handle ongoing orientation dragging
    if (this.isDraggingOrientation) {
      const intersects = this.raycaster.intersectObjects([this.controlPanel]);
      if (intersects.length > 0) {
        const currentPoint = intersects[0].point;
        const delta = currentPoint.clone().sub(this.dragStartPoint);

        // Update orientation offset based on controller movement
        this.orientationOffset.x = this.dragStartRotation.x + delta.y * 3;
        this.orientationOffset.y = this.dragStartRotation.y - delta.x * 3;

        // Clamp vertical rotation
        this.orientationOffset.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.orientationOffset.x));

        this.onOrientationChange(this.orientationOffset);
      }
      return;
    }

    // Handle ongoing scrub dragging
    if (this.isDraggingScrub) {
      const intersects = this.raycaster.intersectObjects([this.scrubTrack]);
      if (intersects.length > 0) {
        const localPoint = this.scrubTrack.worldToLocal(intersects[0].point.clone());
        const progress = (localPoint.x + this.scrubTrackWidth / 2) / this.scrubTrackWidth;
        const clampedProgress = Math.max(0, Math.min(1, progress));

        if (this.player.duration()) {
          this.player.currentTime(this.player.duration() * clampedProgress);
        }
      }
      return;
    }

    // Regular button clicks
    const intersects = this.raycaster.intersectObjects(this.interactiveElements);
    if (intersects.length > 0) {
      this.handleInteraction(intersects[0].object, intersects[0].point);
    }
  }

  onSqueezeStart(event) {
    // Grip squeeze shows the HUD (doesn't toggle)
    if (this.hudGroup && !this.isVisible) {
      this.show(true); // Force show even if not in XR (though we should be)
      this.resetAutoHideTimer();
    }
  }

  onSqueezeEnd(event) {
    // Squeeze end - could be used for other interactions
  }

  onPinchStart(event) {
    // Hand pinch gesture - show HUD if hidden, or act like trigger select if visible
    if (!this.isVisible) {
      this.show(true);
      this.resetAutoHideTimer();
      return;
    }

    const hand = event.target;
    this.tempMatrix = new THREE.Matrix4();
    this.tempMatrix.identity().extractRotation(hand.matrixWorld);

    this.raycaster.ray.origin.setFromMatrixPosition(hand.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

    const intersects = this.raycaster.intersectObjects(this.interactiveElements);

    if (intersects.length > 0) {
      this.handleInteraction(intersects[0].object, intersects[0].point);
    }
  }

  onPinchEnd(event) {
    // Pinch release
  }

  handleInteraction(object, point) {
    const type = object.userData.type;

    // Reset auto-hide timer on any interaction
    this.resetAutoHideTimer();

    switch (type) {
      case 'play-pause':
        if (this.player.paused()) {
          this.player.play();
        } else {
          this.player.pause();
        }
        break;

      case 'previous':
        this.onPrevious();
        break;

      case 'next':
        this.onNext();
        break;

      case 'gallery':
        this.onGallery();
        break;

      case 'exit-vr':
        this.onExit();
        // Also try to exit XR session
        if (this.renderer.xr && this.renderer.xr.getSession()) {
          this.renderer.xr.getSession().end();
        }
        break;

      case 'reset-orientation':
        this.orientationOffset.set(0, 0, 0);
        this.onOrientationChange(this.orientationOffset);
        break;

      case 'scrub':
      case 'scrub-handle':
        const localPoint = this.scrubTrack.worldToLocal(point.clone());
        const progress = (localPoint.x + this.scrubTrackWidth / 2) / this.scrubTrackWidth;
        const clampedProgress = Math.max(0, Math.min(1, progress));

        if (this.player.duration()) {
          this.player.currentTime(this.player.duration() * clampedProgress);
        }
        break;
    }
  }

  resetAutoHideTimer() {
    // Clear existing timer
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
    }

    // Set new timer to auto-hide after delay
    if (this.isVisible && this.autoHideDelay > 0) {
      this.hideTimeout = setTimeout(() => {
        this.hide();
      }, this.autoHideDelay);
    }
  }

  formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  updateTimeDisplay() {
    const currentTime = this.player.currentTime() || 0;
    const duration = this.player.duration() || 0;

    this.timeContext.clearRect(0, 0, 256, 64);
    this.timeContext.fillStyle = '#ffffff';
    this.timeContext.font = 'bold 24px Arial';
    this.timeContext.textAlign = 'center';
    this.timeContext.textBaseline = 'middle';
    this.timeContext.fillText(
      `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`,
      128, 32
    );

    this.timeTexture.needsUpdate = true;
  }

  updateScrubBar() {
    const currentTime = this.player.currentTime() || 0;
    const duration = this.player.duration() || 1;
    const progress = currentTime / duration;

    // Update progress bar width (removed - no blue bar)
    const progressWidth = this.scrubTrackWidth * progress;
    // this.scrubProgress.scale.x = Math.max(0.01, progressWidth);
    // this.scrubProgress.position.x = -this.scrubTrackWidth / 2 + progressWidth / 2;

    // Update handle position
    this.scrubHandle.position.x = -this.scrubTrackWidth / 2 + progressWidth;
  }

  updateCursor() {
    // Raycast from camera center
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactiveElements);

    if (intersects.length > 0) {
      // Hovering over interactive element
      this.cursorHover.material.opacity = 0.8;
      this.cursorDot.material.color.setHex(0x00ff00);

      // Highlight the hovered element
      const obj = intersects[0].object;
      if (obj.userData.baseColor !== undefined) {
        obj.material.color.setHex(obj.userData.hoverColor || 0x00ffff);
      }

      // Position cursor at intersection
      const cursorPos = intersects[0].point.clone();
      this.camera.worldToLocal(cursorPos);
      this.cursor.position.copy(cursorPos);
    } else {
      // Not hovering
      this.cursorHover.material.opacity = 0;
      this.cursorDot.material.color.setHex(0x00ffff);
      this.cursor.position.set(0, 0, -2);

      // Reset all interactive elements to base color
      this.interactiveElements.forEach(el => {
        if (el.userData.baseColor !== undefined) {
          el.material.color.setHex(el.userData.baseColor);
        }
      });
    }
  }

  update() {
    // Always update controller rays even when HUD is hidden (so user can see where they're pointing)
    this.updateControllerRays();

    if (!this.isVisible) return;

    this.updateScrubBar();
    this.updateTimeDisplay();
    this.updateCursor();

    // Make HUD follow camera at constant distance
    // Position HUD in front of camera at fixed distance at eye level
    const cameraDirection = new THREE.Vector3(0, 0, -1);
    cameraDirection.applyQuaternion(this.camera.quaternion);

    this.hudGroup.position.copy(this.camera.position);
    this.hudGroup.position.addScaledVector(cameraDirection, this.hudDistance);
    // HUD at eye level (vertical like a wall)
    this.hudGroup.position.y = this.camera.position.y;

    // Make HUD face the camera
    this.hudGroup.quaternion.copy(this.camera.quaternion);
  }

  updateControllerRays() {
    // Check both controllers and show rays when in XR session
    const controllers = [this.controller0, this.controller1];
    const rays = [this.ray0, this.ray1];

    for (let i = 0; i < controllers.length; i++) {
      const controller = controllers[i];
      const ray = rays[i];

      if (!controller || !ray) continue;

      // Only show rays when in XR session
      if (!this.isInXRSession) {
        ray.visible = false;
        continue;
      }

      // Perform raycast from controller
      this.tempMatrix = new THREE.Matrix4();
      this.tempMatrix.identity().extractRotation(controller.matrixWorld);

      this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

      // Always show ray in XR, adjust length based on intersection
      ray.visible = true;

      // Check for intersections with HUD elements (if visible)
      if (this.isVisible) {
        const intersects = this.raycaster.intersectObjects(this.interactiveElements);
        if (intersects.length > 0) {
          // Shorten ray to intersection point and make it brighter
          const distance = intersects[0].distance;
          const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -distance)];
          ray.geometry.setFromPoints(points);
          ray.material.opacity = 0.8; // Brighter when hitting UI
        } else {
          // Default length and dimmer when not hitting anything
          const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)];
          ray.geometry.setFromPoints(points);
          ray.material.opacity = 0.3; // Dimmer when not hitting UI
        }
      } else {
        // HUD hidden - show dim ray at default length
        const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)];
        ray.geometry.setFromPoints(points);
        ray.material.opacity = 0.3;
      }
    }
  }

  createControllerModel() {
    // Create a simple controller visualization (handle + pointer)
    const group = new THREE.Group();

    // Handle/grip
    const handleGeometry = new THREE.CylinderGeometry(0.01, 0.01, 0.1);
    const handleMaterial = new THREE.MeshBasicMaterial({ color: 0x888888 });
    const handle = new THREE.Mesh(handleGeometry, handleMaterial);
    handle.rotation.x = Math.PI / 2;
    group.add(handle);

    // Pointer cone
    const pointerGeometry = new THREE.ConeGeometry(0.008, 0.03, 8);
    const pointerMaterial = new THREE.MeshBasicMaterial({ color: 0xaaaaaa });
    const pointer = new THREE.Mesh(pointerGeometry, pointerMaterial);
    pointer.position.set(0, 0, -0.065);
    pointer.rotation.x = Math.PI / 2;
    group.add(pointer);

    return group;
  }

  createHandModel() {
    // Create a simple hand visualization (palm sphere)
    const palmGeometry = new THREE.SphereGeometry(0.04, 16, 16);
    const palmMaterial = new THREE.MeshBasicMaterial({
      color: 0xffddbb,
      transparent: true,
      opacity: 0.8,
      wireframe: true
    });
    const palm = new THREE.Mesh(palmGeometry, palmMaterial);
    return palm;
  }

  show(force = false) {
    // Only show if in XR session or forced
    if (!this.isInXRSession && !force) {
      return;
    }
    this.isVisible = true;
    this.hudGroup.visible = true;
    this.cursor.visible = true;
  }

  hide() {
    this.isVisible = false;
    this.hudGroup.visible = false;
    this.cursor.visible = false;
  }

  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  // Check if currently in XR session
  isXRActive() {
    return this.isInXRSession;
  }

  setOrientationOffset(euler) {
    this.orientationOffset.copy(euler);
  }

  getOrientationOffset() {
    return this.orientationOffset.clone();
  }

  dispose() {
    // Remove XR listeners
    if (this.renderer.xr) {
      this.renderer.xr.removeEventListener('sessionstart', this.onXRSessionStart);
      this.renderer.xr.removeEventListener('sessionend', this.onXRSessionEnd);
    }

    this.scene.remove(this.hudGroup);
    this.camera.remove(this.cursor);

    // Clean up textures
    if (this.timeTexture) this.timeTexture.dispose();

    // Clean up geometries and materials
    this.hudGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
  }
}

export default VRHUD;

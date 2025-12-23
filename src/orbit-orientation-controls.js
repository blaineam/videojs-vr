import * as THREE from 'three';
import OrbitControls from '../vendor/three/OrbitControls.js';
import DeviceOrientationControls from '../vendor/three/DeviceOrientationControls.js';

/**
 * Convert a quaternion to an angle
 *
 * Taken from https://stackoverflow.com/a/35448946
 * Thanks P. Ellul
 */
function Quat2Angle(x, y, z, w) {
  const test = x * y + z * w;

  // singularity at north pole
  if (test > 0.499) {
    const yaw = 2 * Math.atan2(x, w);
    const pitch = Math.PI / 2;
    const roll = 0;

    return new THREE.Vector3(pitch, roll, yaw);
  }

  // singularity at south pole
  if (test < -0.499) {
    const yaw = -2 * Math.atan2(x, w);
    const pitch = -Math.PI / 2;
    const roll = 0;

    return new THREE.Vector3(pitch, roll, yaw);
  }

  const sqx = x * x;
  const sqy = y * y;
  const sqz = z * z;
  const yaw = Math.atan2(2 * y * w - 2 * x * z, 1 - 2 * sqy - 2 * sqz);
  const pitch = Math.asin(2 * test);
  const roll = Math.atan2(2 * x * w - 2 * y * z, 1 - 2 * sqx - 2 * sqz);

  return new THREE.Vector3(pitch, roll, yaw);
}

class OrbitOrientationControls {
  constructor(options) {
    this.object = options.camera;
    this.domElement = options.canvas;
    this.orbit = new OrbitControls(this.object, this.domElement);

    this.speed = 0.5;
    this.orbit.target.set(0, 0, -1);
    this.orbit.enableZoom = false;
    this.orbit.enablePan = false;
    this.orbit.rotateSpeed = -this.speed;

    // User-adjustable orientation offset (for lying down viewing, etc.)
    this.orientationOffset = new THREE.Euler(0, 0, 0);

    // Temporary quaternion for offset calculations
    this.offsetQuaternion = new THREE.Quaternion();

    // if orientation is supported
    if (options.orientation) {
      this.orientation = new DeviceOrientationControls(this.object);
    }

    // if projection is not full view
    // limit the rotation angle in order to not display back half view
    if (options.halfView) {
      this.orbit.minAzimuthAngle = -Math.PI / 4;
      this.orbit.maxAzimuthAngle = Math.PI / 4;
    }

    // Store initial camera orientation for reset
    this.initialQuaternion = this.object.quaternion.clone();
  }

  /**
   * Set orientation offset (for adjusting view when lying down, etc.)
   *
   * @param {THREE.Euler} euler - Euler angles for offset (pitch, yaw, roll)
   */
  setOrientationOffset(euler) {
    if (euler instanceof THREE.Euler) {
      this.orientationOffset.copy(euler);
    } else if (typeof euler === 'object') {
      this.orientationOffset.set(euler.x || 0, euler.y || 0, euler.z || 0);
    }
  }

  /**
   * Get current orientation offset
   *
   * @return {THREE.Euler}
   */
  getOrientationOffset() {
    return this.orientationOffset.clone();
  }

  /**
   * Reset orientation offset to default
   */
  resetOrientationOffset() {
    this.orientationOffset.set(0, 0, 0);
  }

  /**
   * Adjust orientation offset incrementally
   *
   * @param {number} pitchDelta - Change in pitch (up/down)
   * @param {number} yawDelta - Change in yaw (left/right)
   * @param {number} rollDelta - Change in roll (tilt)
   */
  adjustOrientationOffset(pitchDelta = 0, yawDelta = 0, rollDelta = 0) {
    this.orientationOffset.x += pitchDelta;
    this.orientationOffset.y += yawDelta;
    this.orientationOffset.z += rollDelta;

    // Clamp pitch to avoid flipping
    this.orientationOffset.x = Math.max(
      -Math.PI / 2,
      Math.min(Math.PI / 2, this.orientationOffset.x)
    );
  }

  /**
   * Recenter the view to current head position (useful in VR)
   */
  recenter() {
    if (this.orientation) {
      // Get current device orientation
      const currentQuat = this.object.quaternion.clone();
      const currentAngle = Quat2Angle(
        currentQuat.x,
        currentQuat.y,
        currentQuat.z,
        currentQuat.w
      );

      // Set offset to negate current orientation
      this.orientationOffset.y = -currentAngle.z;
    } else {
      // Reset orbit controls to center
      this.orbit.reset();
    }
  }

  update() {
    // orientation updates the camera using quaternions and
    // orbit updates the camera using angles. They are incompatible
    // and one update overrides the other. So before
    // orbit overrides orientation we convert our quaternion changes to
    // an angle change. Then save the angle into orbit so that
    // it will take those into account when it updates the camera and overrides
    // our changes
    if (this.orientation) {
      this.orientation.update();

      const quat = this.orientation.object.quaternion;
      const currentAngle = Quat2Angle(quat.x, quat.y, quat.z, quat.w);

      // we also have to store the last angle since quaternions are b
      if (typeof this.lastAngle_ === 'undefined') {
        this.lastAngle_ = currentAngle;
      }

      this.orbit.rotateLeft((this.lastAngle_.z - currentAngle.z) * (1 + this.speed));
      this.orbit.rotateUp((this.lastAngle_.y - currentAngle.y) * (1 + this.speed));
      this.lastAngle_ = currentAngle;
    }

    this.orbit.update();

    // Apply user orientation offset after orbit update
    if (this.orientationOffset.x !== 0 ||
        this.orientationOffset.y !== 0 ||
        this.orientationOffset.z !== 0) {

      // Create quaternion from offset euler
      this.offsetQuaternion.setFromEuler(this.orientationOffset);

      // Apply offset to camera
      this.object.quaternion.multiply(this.offsetQuaternion);
    }
  }

  dispose() {
    this.orbit.dispose();

    if (this.orientation) {
      this.orientation.dispose();
    }
  }

}

export default OrbitOrientationControls;

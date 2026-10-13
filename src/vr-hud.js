/* global document */
/* eslint-disable no-inline-comments, newline-after-var, curly, no-console, function-paren-newline, no-multi-spaces */
import * as THREE from 'three';

/**
 * VR HUD - In-VR User Interface with modern controls
 * Provides scrub bar, navigation, and orientation controls
 * Only visible when in WebXR/HMD mode
 */
const HAND_CHAINS = [
  ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['wrist', 'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  ['wrist', 'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['wrist', 'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['wrist', 'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip']
];
const HAND_JOINTS = Array.from(new Set([].concat(...HAND_CHAINS)));
const HAND_BONES = [];

HAND_CHAINS.forEach((chain) => {
  for (let i = 0; i < chain.length - 1; i++) {
    HAND_BONES.push([chain[i], chain[i + 1]]);
  }
});

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
    this.onProjectionChange = options.onProjectionChange || (() => {});
    this.onFavorite = options.onFavorite || null; // Optional favorite callback
    this.onForceMonoToggle = options.onForceMonoToggle || null; // Callback for force mono toggle
    this.onLockChange = options.onLockChange || null; // Callback when controls are locked/unlocked (clap)

    // Force mono state (persists for VR session duration)
    this.forceMonoEnabled = false;

    // Projection modes available
    this.projectionModes = [
      { id: '180', label: '180°' },
      { id: '180_LR', label: '180° LR' },
      { id: '180_MONO', label: '180° Mono' },
      { id: '360', label: '360°' },
      { id: '360_LR', label: '360° LR' },
      { id: '360_TB', label: '360° TB' },
      { id: 'EAC', label: 'EAC' },
      { id: 'EAC_LR', label: 'EAC LR' },
      { id: 'Sphere', label: 'Sphere' },
      { id: 'SBS_MONO', label: 'Side by Side' },
      { id: 'FISHEYE_180', label: 'Fisheye 180°' },
      { id: 'FISHEYE_180_LR', label: 'Fisheye 180° LR' },
      { id: 'FISHEYE_200', label: 'Fisheye 200°' },
      { id: 'FISHEYE_200_LR', label: 'Fisheye 200° LR' },
      { id: 'FISHEYE_220', label: 'Fisheye 220°' },
      { id: 'FISHEYE_220_LR', label: 'Fisheye 220° LR' },
      { id: 'FISHEYE_360', label: 'Fisheye 360°' },
      { id: 'FISHEYE_360_LR', label: 'Fisheye 360° LR' }
    ];
    this.currentProjection = '180';
    this.projectionMenuVisible = false;
    // Scrollable menu: keep the panel a fixed height regardless of how
    // many projection modes exist. Visible window slides through the
    // list with the up/down arrows added below the entries.
    this.projectionMenuItemsPerPage = 8;
    this.projectionMenuScrollOffset = 0;

    // HUD configuration (can be overridden by options)
    // Reduced distance from 4 to 1.5 to minimize stereo parallax and double vision
    this.hudDistance = options.hudDistance !== undefined ? options.hudDistance : 1.5;
    this.hudHeight = options.hudHeight !== undefined ? options.hudHeight : 1.5;
    this.hudScale = options.hudScale !== undefined ? options.hudScale : 0.015;
    this.autoHideDelay = options.autoHideDelay !== undefined ? options.autoHideDelay : 10000;

    // Stereo comfort: draw the HUD much closer than the video content (scaled
    // down so it keeps the same angular size). When the HUD sits farther away
    // than objects in a 3D video, the eyes get contradictory depth cues (the
    // HUD overdraws things that are stereoscopically in front of it) and it
    // looks doubled whenever you're focused on the video.
    const near = options.hudNearDistance !== undefined ? options.hudNearDistance : 1.0;

    this.effectiveHudDistance = near > 0 ? near : this.hudDistance;
    this.hudAnchorY = 1.2; // Updated to head height each time the HUD is shown

    // Interaction state
    this.isVisible = false; // Start hidden, only show in WebXR
    this.isInXRSession = false;
    this.hideTimeout = null;
    this.isDraggingOrientation = false;
    this.isDraggingScrub = false;

    // Joystick state
    this.lastJoystickSeek = 0; // Throttle joystick seek
    this.joystickSeekSpeed = 5; // Seconds to seek per joystick input
    this.joystickScrollSpeed = 0.5; // Gallery scroll speed multiplier

    // VR Gallery reference (set by plugin)
    this.vrGallery = null;

    // Orientation offset (for lying down viewing)
    // Use YXZ order: yaw (Y) first, then pitch (X), to prevent horizon roll
    this.orientationOffset = new THREE.Euler(0, 0, 0, 'YXZ');

    // Raycaster for gaze/pointer interaction
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(0, 0); // Center of screen for gaze

    // Interactive elements for raycasting - must be initialized before create* methods
    this.interactiveElements = [];

    // Create HUD elements
    this.hudGroup = new THREE.Group();
    this.hudGroup.name = 'vr-hud';
    this.hudGroup.visible = false; // Start hidden
    this.hudGroup.scale.setScalar(this.effectiveHudDistance / this.hudDistance);

    this.createCursor();
    this.createControlPanel();
    this.createScrubBar();
    this.createNavigationButtons();
    this.createProjectionMenu();
    this.createHandHint();

    this.scene.add(this.hudGroup);

    // Enable HUD to be visible on camera layers 0, 1, 2
    // This ensures it renders correctly for both eyes in stereoscopic mode
    this.hudGroup.traverse((obj) => {
      if (obj.isMesh || obj.isGroup) {
        obj.layers.set(0);
        obj.layers.enable(1);
        obj.layers.enable(2);
      }
    });

    // Bind methods
    this.update = this.update.bind(this);
    this.onSelect = this.onSelect.bind(this);
    this.onSelectStart = this.onSelectStart.bind(this);
    this.onSelectEnd = this.onSelectEnd.bind(this);
    this.onSqueezeStart = this.onSqueezeStart.bind(this);
    this.onSqueezeEnd = this.onSqueezeEnd.bind(this);
    this.onXRSessionStart = this.onXRSessionStart.bind(this);
    this.onXRSessionEnd = this.onXRSessionEnd.bind(this);

    this.initHandState(options);

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
    this.handModeAnnounced = false;
    // Controllers: HUD stays hidden until the user squeezes the grip.
    // Hands: HUD is shown once when hands are first detected (see update()),
    // then toggled by tapping/pinching the air.
  }

  onXRSessionEnd() {
    this.isInXRSession = false;
    this.controlsLocked = false;
    this.gestureDrag = null;
    this.handAnnouncePending = false;
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
    // Background panel for controls - Dark glassmorphic design (no blue tint)
    const panelWidth = 2.6;
    const panelHeight = 0.6;
    const cornerRadius = 0.08;

    // Create rounded rectangle shape
    const shape = this.createRoundedRectShape(panelWidth, panelHeight, cornerRadius);
    const panelGeometry = new THREE.ShapeGeometry(shape);
    // Center the geometry
    panelGeometry.translate(-panelWidth / 2, -panelHeight / 2, 0);

    // Main panel - dark semi-transparent (like dark mode glass)
    const panelMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a, // Neutral dark gray, no blue tint
      opacity: 0.85,
      transparent: true,
      side: THREE.DoubleSide
    });

    this.controlPanel = new THREE.Mesh(panelGeometry, panelMaterial);
    this.controlPanel.name = 'control-panel';
    this.controlPanel.position.set(0, 0, 0);

    // Subtle border - very faint white
    const borderShape = this.createRoundedRectShape(panelWidth + 0.02, panelHeight + 0.02, cornerRadius + 0.01);
    const borderGeometry = new THREE.ShapeGeometry(borderShape);
    borderGeometry.translate(-(panelWidth + 0.02) / 2, -(panelHeight + 0.02) / 2, 0);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      opacity: 0.1,
      transparent: true,
      side: THREE.DoubleSide
    });
    const border = new THREE.Mesh(borderGeometry, borderMaterial);
    border.position.z = -0.001;
    this.controlPanel.add(border);

    this.hudGroup.add(this.controlPanel);
  }

  // Helper to create rounded rectangle shape
  createRoundedRectShape(width, height, radius) {
    const shape = new THREE.Shape();
    shape.moveTo(radius, 0);
    shape.lineTo(width - radius, 0);
    shape.quadraticCurveTo(width, 0, width, radius);
    shape.lineTo(width, height - radius);
    shape.quadraticCurveTo(width, height, width - radius, height);
    shape.lineTo(radius, height);
    shape.quadraticCurveTo(0, height, 0, height - radius);
    shape.lineTo(0, radius);
    shape.quadraticCurveTo(0, 0, radius, 0);
    return shape;
  }

  // Helper to create horizontal pill shape with true semicircular ends
  createPillShape(width, height) {
    const shape = new THREE.Shape();
    const radius = height / 2;
    // Start at top-left (after left semicircle)
    shape.moveTo(radius, height);
    // Top edge to right
    shape.lineTo(width - radius, height);
    // Right semicircle (clockwise from top to bottom)
    shape.absarc(width - radius, radius, radius, Math.PI / 2, -Math.PI / 2, true);
    // Bottom edge to left
    shape.lineTo(radius, 0);
    // Left semicircle (clockwise from bottom to top)
    shape.absarc(radius, radius, radius, -Math.PI / 2, Math.PI / 2, true);
    return shape;
  }

  createScrubBar() {
    const scrubGroup = new THREE.Group();

    scrubGroup.name = 'scrub-bar-group';

    // Track background with true semicircular ends (pill shape)
    const trackWidth = 1.8;
    const trackHeight = 0.08;

    const trackShape = this.createPillShape(trackWidth, trackHeight);
    const trackGeometry = new THREE.ShapeGeometry(trackShape);
    trackGeometry.translate(-trackWidth / 2, -trackHeight / 2, 0);
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

    // Calculate button positions to fit within panel (width 2.6)
    // With favorite button: 10 buttons (including force mono), spacing ~0.22
    // Without favorite: 9 buttons, spacing ~0.24
    const hasOnFavorite = !!this.onFavorite;
    const buttonSpacing = hasOnFavorite ? 0.22 : 0.24;
    const startX = hasOnFavorite ? -0.99 : -0.96;

    // Exit VR button (leftmost) - neutral base, red on hover
    this.exitBtn = this.createButton('✕', startX, -0.15, 'exit-vr', 0x2a2a2a, 0xff3366);
    buttonGroup.add(this.exitBtn);

    // Gallery button
    this.galleryBtn = this.createButton('⊞', startX + buttonSpacing * 1, -0.15, 'gallery');
    buttonGroup.add(this.galleryBtn);

    // Previous button
    this.prevBtn = this.createButton('⏮', startX + buttonSpacing * 2, -0.15, 'previous');
    buttonGroup.add(this.prevBtn);

    // Play/Pause button
    this.playPauseBtn = this.createButton('⏯', startX + buttonSpacing * 3, -0.15, 'play-pause');
    buttonGroup.add(this.playPauseBtn);

    // Next button
    this.nextBtn = this.createButton('⏭', startX + buttonSpacing * 4, -0.15, 'next');
    buttonGroup.add(this.nextBtn);

    // Force Mono toggle button - shows larger single eye icon
    this.forceMonoBtn = this.createButton('○', startX + buttonSpacing * 5, -0.15, 'force-mono', 0x2a3a5a);
    buttonGroup.add(this.forceMonoBtn);

    // Orientation reset button
    this.orientResetBtn = this.createButton('⟲', startX + buttonSpacing * 6, -0.15, 'reset-orientation');
    buttonGroup.add(this.orientResetBtn);

    // Orientation drag handle
    this.orientDragBtn = this.createButton('✋', startX + buttonSpacing * 7, -0.15, 'orientation-handle');
    buttonGroup.add(this.orientDragBtn);

    // Projection menu button
    this.projectionBtn = this.createButton('🎬', startX + buttonSpacing * 8, -0.15, 'projection-menu');
    buttonGroup.add(this.projectionBtn);

    // Favorite button (only if callback is provided) - rightmost
    if (hasOnFavorite) {
      this.favoriteBtn = this.createButton('☆', startX + buttonSpacing * 9, -0.15, 'favorite');
      this.favoriteBtnMesh = this.favoriteBtn.children.find(c => c.userData && c.userData.type === 'favorite');
      buttonGroup.add(this.favoriteBtn);
    }

    this.controlPanel.add(buttonGroup);
  }

  createButton(label, x, y, type, customColor, customHoverColor) {
    const btnGroup = new THREE.Group();

    btnGroup.name = `btn-${type}`;

    // Button background - dark glassmorphic circle (no blue tint)
    const btnGeometry = new THREE.CircleGeometry(0.08, 32);
    const baseColor = customColor || 0x2a2a2a; // Neutral dark gray
    const btnMaterial = new THREE.MeshBasicMaterial({
      color: baseColor,
      opacity: 0.9,
      transparent: true
    });

    const btnMesh = new THREE.Mesh(btnGeometry, btnMaterial);

    btnMesh.userData.interactive = true;
    btnMesh.userData.type = type;
    btnMesh.userData.baseColor = baseColor;
    btnMesh.userData.hoverColor = customHoverColor || 0x444444; // Lighter gray on hover (or custom)

    btnGroup.add(btnMesh);

    // Subtle white border
    const borderGeometry = new THREE.RingGeometry(0.078, 0.082, 32);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      opacity: 0.15,
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

  createProjectionMenu() {
    // Create projection selection menu (hidden by default) - Dark glassmorphic design
    this.projectionMenu = new THREE.Group();
    this.projectionMenu.name = 'projection-menu';
    this.projectionMenu.visible = false;

    // Fixed-height menu regardless of how many projections are registered.
    // We allocate `itemsPerPage` slot meshes and slide a window of items
    // through them via up/down arrows + the scroll offset.
    const itemsPerPage = this.projectionMenuItemsPerPage;
    const rowSpacing = 0.08;
    // Extra rows worth of vertical space for the up/down arrow buttons.
    const arrowRow = 0.07;
    const menuWidth = 0.5;
    const menuHeight = itemsPerPage * rowSpacing + arrowRow * 2 + 0.05;
    const cornerRadius = 0.04;

    const menuShape = this.createRoundedRectShape(menuWidth, menuHeight, cornerRadius);
    const menuGeometry = new THREE.ShapeGeometry(menuShape);
    menuGeometry.translate(-menuWidth / 2, -menuHeight / 2, 0);
    const menuMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a,
      opacity: 0.9,
      transparent: true,
      side: THREE.DoubleSide
    });
    const menuBg = new THREE.Mesh(menuGeometry, menuMaterial);

    this.projectionMenu.add(menuBg);

    // Subtle white border
    const borderShape = this.createRoundedRectShape(menuWidth + 0.02, menuHeight + 0.02, cornerRadius + 0.01);
    const borderGeometry = new THREE.ShapeGeometry(borderShape);
    borderGeometry.translate(-(menuWidth + 0.02) / 2, -(menuHeight + 0.02) / 2, 0);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      opacity: 0.1,
      transparent: true,
      side: THREE.DoubleSide
    });
    const border = new THREE.Mesh(borderGeometry, borderMaterial);

    border.position.z = -0.001;
    this.projectionMenu.add(border);

    // Slot meshes: stable count, dynamic content updated by refresh.
    this.projectionOptionButtons = [];
    this.projectionOptionLabels = [];

    const itemsTopY = menuHeight / 2 - arrowRow - 0.02;
    const itemsBottomY = -menuHeight / 2 + arrowRow + 0.02;

    for (let i = 0; i < itemsPerPage; i++) {
      const slotY = itemsTopY - i * rowSpacing;

      const btnWidth = menuWidth - 0.06;
      const btnHeight = 0.065;
      const btnShape = this.createRoundedRectShape(btnWidth, btnHeight, 0.015);
      const btnGeometry = new THREE.ShapeGeometry(btnShape);
      btnGeometry.translate(-btnWidth / 2, -btnHeight / 2, 0);
      const btnMaterial = new THREE.MeshBasicMaterial({
        color: 0x1a1a3a,
        opacity: 0.9,
        transparent: true
      });
      const btnMesh = new THREE.Mesh(btnGeometry, btnMaterial);

      btnMesh.position.set(0, slotY, 0.002);
      btnMesh.userData.interactive = true;
      btnMesh.userData.type = 'projection-option';
      btnMesh.userData.slotIndex = i;
      btnMesh.userData.projectionId = '';
      btnMesh.userData.baseColor = 0x1a1a3a;
      btnMesh.userData.hoverColor = 0x004466;
      this.projectionMenu.add(btnMesh);
      this.interactiveElements.push(btnMesh);

      const labelCanvas = document.createElement('canvas');

      labelCanvas.width = 256;
      labelCanvas.height = 32;
      const labelTexture = new THREE.CanvasTexture(labelCanvas);
      const labelMaterial = new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true });
      const labelGeometry = new THREE.PlaneGeometry(0.35, 0.04);
      const labelMesh = new THREE.Mesh(labelGeometry, labelMaterial);

      labelMesh.position.set(0, slotY, 0.003);
      this.projectionMenu.add(labelMesh);

      this.projectionOptionButtons.push({ mesh: btnMesh, slotIndex: i });
      this.projectionOptionLabels.push({ canvas: labelCanvas, ctx: labelCanvas.getContext('2d'), texture: labelTexture, mesh: labelMesh });
    }

    // Up arrow (top of menu) and down arrow (bottom).
    const arrowGeometry = new THREE.PlaneGeometry(0.18, 0.05);
    const arrowMakeLabel = (glyph) => {
      const c = document.createElement('canvas');

      c.width = 128;
      c.height = 48;
      const cx = c.getContext('2d');

      cx.fillStyle = '#ffffff';
      cx.font = 'bold 36px Arial';
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      cx.fillText(glyph, 64, 24);
      return new THREE.CanvasTexture(c);
    };
    const arrowBtnMaterial = () => new THREE.MeshBasicMaterial({
      color: 0x222244,
      opacity: 0.9,
      transparent: true
    });

    const upY = menuHeight / 2 - arrowRow / 2 - 0.01;
    const downY = -menuHeight / 2 + arrowRow / 2 + 0.01;

    const upMesh = new THREE.Mesh(arrowGeometry, arrowBtnMaterial());

    upMesh.position.set(0, upY, 0.002);
    upMesh.userData.interactive = true;
    upMesh.userData.type = 'projection-scroll';
    upMesh.userData.scrollDir = -1;
    upMesh.userData.baseColor = 0x222244;
    upMesh.userData.hoverColor = 0x004466;
    this.projectionMenu.add(upMesh);
    this.interactiveElements.push(upMesh);

    const upLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.18, 0.05),
      new THREE.MeshBasicMaterial({ map: arrowMakeLabel('▲'), transparent: true })
    );

    upLabel.position.set(0, upY, 0.003);
    this.projectionMenu.add(upLabel);

    const downMesh = new THREE.Mesh(arrowGeometry, arrowBtnMaterial());

    downMesh.position.set(0, downY, 0.002);
    downMesh.userData.interactive = true;
    downMesh.userData.type = 'projection-scroll';
    downMesh.userData.scrollDir = 1;
    downMesh.userData.baseColor = 0x222244;
    downMesh.userData.hoverColor = 0x004466;
    this.projectionMenu.add(downMesh);
    this.interactiveElements.push(downMesh);

    const downLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.18, 0.05),
      new THREE.MeshBasicMaterial({ map: arrowMakeLabel('▼'), transparent: true })
    );

    downLabel.position.set(0, downY, 0.003);
    this.projectionMenu.add(downLabel);

    this.projectionScrollUp = upMesh;
    this.projectionScrollDown = downMesh;

    // Suppress unused-var lint: itemsBottomY is the visual marker for the
    // bottom row, which the constants above already encode via downY.
    void itemsBottomY;

    this.refreshProjectionMenu();

    // Position menu above the projection button - raised higher to avoid clipping
    this.projectionMenu.position.set(0.8, 0.55, 0.02);

    this.controlPanel.add(this.projectionMenu);
  }

  refreshProjectionMenu() {
    if (!this.projectionOptionButtons || !this.projectionOptionLabels) {
      return;
    }
    const itemsPerPage = this.projectionMenuItemsPerPage;
    const total = this.projectionModes.length;
    const maxOffset = Math.max(0, total - itemsPerPage);

    if (this.projectionMenuScrollOffset > maxOffset) {
      this.projectionMenuScrollOffset = maxOffset;
    }
    if (this.projectionMenuScrollOffset < 0) {
      this.projectionMenuScrollOffset = 0;
    }

    for (let slot = 0; slot < itemsPerPage; slot++) {
      const idx = this.projectionMenuScrollOffset + slot;
      const btn = this.projectionOptionButtons[slot];
      const lbl = this.projectionOptionLabels[slot];

      if (idx < total) {
        const mode = this.projectionModes[idx];

        btn.mesh.visible = true;
        btn.mesh.userData.projectionId = mode.id;
        lbl.mesh.visible = true;
        lbl.ctx.clearRect(0, 0, lbl.canvas.width, lbl.canvas.height);
        lbl.ctx.fillStyle = '#ffffff';
        lbl.ctx.font = 'bold 22px Arial';
        lbl.ctx.textAlign = 'center';
        lbl.ctx.textBaseline = 'middle';
        lbl.ctx.fillText(mode.label, 128, 16);
        lbl.texture.needsUpdate = true;
      } else {
        btn.mesh.visible = false;
        btn.mesh.userData.projectionId = '';
        lbl.mesh.visible = false;
      }
    }

    if (this.projectionScrollUp) {
      this.projectionScrollUp.material.opacity = this.projectionMenuScrollOffset === 0 ? 0.3 : 0.9;
    }
    if (this.projectionScrollDown) {
      this.projectionScrollDown.material.opacity = this.projectionMenuScrollOffset >= maxOffset ? 0.3 : 0.9;
    }
  }

  scrollProjectionMenu(direction) {
    const itemsPerPage = this.projectionMenuItemsPerPage;
    const maxOffset = Math.max(0, this.projectionModes.length - itemsPerPage);

    this.projectionMenuScrollOffset = Math.min(
      maxOffset,
      Math.max(0, this.projectionMenuScrollOffset + direction)
    );
    this.refreshProjectionMenu();
  }

  toggleProjectionMenu() {
    this.projectionMenuVisible = !this.projectionMenuVisible;
    this.projectionMenu.visible = this.projectionMenuVisible;
  }

  hideProjectionMenu() {
    this.projectionMenuVisible = false;
    this.projectionMenu.visible = false;
  }

  setProjection(projectionId) {
    this.currentProjection = projectionId;
    // Update button highlights to show current projection
    this.projectionOptionButtons.forEach(btn => {
      const isSelected = btn.id === projectionId;
      // Use darker colors that still contrast well with white text

      btn.mesh.material.color.setHex(isSelected ? 0x006644 : 0x1a1a3a);
      btn.mesh.userData.baseColor = isSelected ? 0x006644 : 0x1a1a3a;
    });
  }

  // Update favorite button to show current state
  setFavoriteState(isFavorited) {
    this.isFavorited = isFavorited;
    if (this.favoriteBtn) {
      // Find the label mesh (it has a canvas texture)
      const labelMesh = this.favoriteBtn.children.find(c => c.material && c.material.map);

      if (labelMesh) {
        // Update the canvas texture
        const canvas = document.createElement('canvas');

        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = isFavorited ? '#ff6699' : '#ffffff';
        ctx.font = '40px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(isFavorited ? '❤️' : '☆', 32, 32);

        const newTexture = new THREE.CanvasTexture(canvas);

        if (labelMesh.material.map) {
          labelMesh.material.map.dispose();
        }
        labelMesh.material.map = newTexture;
        labelMesh.material.needsUpdate = true;
      }

      // Also update the button background color
      const btnMesh = this.favoriteBtn.children.find(c => c.userData && c.userData.type === 'favorite');

      if (btnMesh) {
        btnMesh.material.color.setHex(isFavorited ? 0x663355 : 0x2a2a4a);
        btnMesh.userData.baseColor = isFavorited ? 0x663355 : 0x2a2a4a;
      }
    }
  }

  // Get current favorite state
  getFavoriteState() {
    return this.isFavorited || false;
  }

  // ---------------------------------------------------------------------
  // Hand tracking support
  //
  // Hands arrive as WebXR input sources with `.hand` set. The Quest browser
  // gives them a target ray and fires select* events on index-finger pinch, so
  // the controller code paths keep working. On top of that this adds:
  //   - rendered hands (joint spheres) plus a pinch-aware cursor at the hit point
  //   - a smoothed pointer ray (pinch causes jitter)
  //   - tap the air = show/hide controls, pinch+drag the air left/right = seek
  //   - thumb + middle finger pinch = play/pause (A-button replacement)
  //   - clap = lock / unlock all controls (pocket-proof while hands are idle)
  // ---------------------------------------------------------------------
  initHandState(options) {
    this.handGesturesEnabled = options.handGestures !== false;
    this.showHandModels = options.showHandModels === true; // off by default: the beam is enough
    this.helpVisible = false;
    this.controlsLocked = false;
    this.inputSources = [null, null];
    this.hands = [null, null];
    this.handCursors = [null, null];
    this.pinching = [false, false];
    this.handRays = [0, 1].map(() => ({
      init: false,
      origin: new THREE.Vector3(),
      quat: new THREE.Quaternion()
    }));
    this.gestureDrag = null;
    this.handModeAnnounced = false;
    this.handAnnouncePending = false;
    this.midPinch = [0, 1].map(() => ({
      down: false,
      since: 0,
      moved: false,
      axis: null,
      start: new THREE.Vector3(),
      right: new THREE.Vector3(1, 0, 0),
      startTime: 0,
      startedAt: 0,
      lastSeek: 0,
      lastScrollY: 0
    }));
    this.clapState = { armed: true, since: 0, lastD: 1, lastSeen: 0 };
    this.selectStartDirs = [new THREE.Vector3(), new THREE.Vector3()];
    // +1: hand up scrolls the grid up (toward the first items); -1 flips it
    this.galleryScrollSign = 1;
    this.lastPlayPauseToggle = 0;
    this.clapHistory = [];
    this.lastClap = 0;
    this.toast = null;
    this.tmpA = new THREE.Vector3();
    this.tmpB = new THREE.Vector3();
    this.tmpC = new THREE.Vector3();
    this.tmpQuat = new THREE.Quaternion();
    this.tmpScale = new THREE.Vector3();
    this.handModels = [null, null];
    this.beams = [null, null];
    this.jointMaterial = new THREE.MeshBasicMaterial({ color: 0xe6f6ff });
    this.boneMaterial = new THREE.MeshBasicMaterial({ color: 0x8fcdea });
    this.jointMatrix = new THREE.Matrix4();
    this.jointScale = new THREE.Vector3();
    this.unitY = new THREE.Vector3(0, 1, 0);
    this.jointPositions = {};
    this.jointRadii = {};
  }

  createHandHint() {
    const canvas = document.createElement('canvas');

    canvas.width = 1536;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');

    // Dark rounded backing so the text stays readable over bright video
    ctx.fillStyle = 'rgba(10, 10, 10, 0.72)';
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(0, 0, canvas.width, canvas.height, 48);
    } else {
      ctx.rect(0, 0, canvas.width, canvas.height);
    }
    ctx.fill();

    ctx.font = 'bold 40px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillStyle = '#ffffff';
    [
      'Pinch a button to press it  •  Pinch empty air to show / hide',
      'Thumb + middle finger: tap = play / pause  •  hold + swipe ← → seek, ↑ ↓ scroll',
      'Hold both palms together to lock / unlock'
    ].forEach((line, k) => {
      ctx.strokeText(line, 768, 48 + k * 72);
      ctx.fillText(line, 768, 48 + k * 72);
    });

    this.handHintTexture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({ map: this.handHintTexture, transparent: true });

    this.handHint = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.406), material);
    this.handHint.name = 'hand-hint';
    this.handHint.position.set(0, -0.55, 0.01);
    this.handHint.visible = false;
    this.hudGroup.add(this.handHint);

    // "?" toggles the gesture cheat-sheet (only offered when hands are in use)
    this.helpBtn = this.createButton('?', 1.12, 0.45, 'help');
    this.helpBtn.visible = false;
    this.hudGroup.add(this.helpBtn);
  }

  setupHandVisuals() {
    const allLayers = (obj) => {
      obj.layers.set(0);
      obj.layers.enable(1);
      obj.layers.enable(2);
    };
    const sphere = new THREE.SphereGeometry(1, 10, 8);
    const bone = new THREE.CylinderGeometry(1, 1, 1, 8, 1);

    this.beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    this.beamGeometry.rotateX(-Math.PI / 2);
    this.beamGeometry.translate(0, 0, -0.5);

    for (let i = 0; i < 2; i++) {
      // Three's hand group only gets joint poses; it must be in the scene for
      // the joints to update. The visible hand is drawn separately (below)
      // from the joint world positions every frame, because meshes parented
      // to joints keep a stale world matrix (joints have matrixAutoUpdate off).
      const hand = this.renderer.xr.getHand(i);

      this.scene.add(hand);
      this.hands[i] = hand;

      const joints = new THREE.InstancedMesh(sphere, this.jointMaterial, HAND_JOINTS.length);
      const bones = new THREE.InstancedMesh(bone, this.boneMaterial, HAND_BONES.length);

      [joints, bones].forEach((m) => {
        m.frustumCulled = false;
        m.visible = false;
        m.name = 'hand-model';
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        allLayers(m);
        this.scene.add(m);
      });
      this.handModels[i] = { joints, bones };

      // Pointer beam (smoothed ray, always shown for tracked hands)
      const beam = new THREE.Mesh(this.beamGeometry, new THREE.MeshBasicMaterial({
        color: 0x66ddff,
        transparent: true,
        opacity: 0.3,
        depthTest: false,
        depthWrite: false
      }));

      beam.name = `hand-beam-${i}`;
      beam.renderOrder = 996;
      beam.frustumCulled = false;
      beam.visible = false;
      allLayers(beam);
      this.scene.add(beam);
      this.beams[i] = beam;

      // Cursor on whatever the beam hits: ring + centre dot, constant angular size
      const cursor = new THREE.Mesh(
        new THREE.RingGeometry(0.035, 0.055, 32),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.95,
          side: THREE.DoubleSide,
          depthTest: false
        })
      );
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.02, 16),
        new THREE.MeshBasicMaterial({
          color: 0x66ddff,
          transparent: true,
          opacity: 0.95,
          side: THREE.DoubleSide,
          depthTest: false
        })
      );

      cursor.add(dot);
      dot.renderOrder = 999;
      cursor.name = `hand-cursor-${i}`;
      cursor.renderOrder = 998;
      cursor.visible = false;
      allLayers(cursor);
      allLayers(dot);
      this.scene.add(cursor);
      this.handCursors[i] = cursor;
    }
  }

  onInputSourceConnected(index, source) {
    this.inputSources[index] = source || null;
    this.handRays[index].init = false;
    this.pinching[index] = false;
    if (source && source.hand && !this.handModeAnnounced && this.handGesturesEnabled) {
      this.handModeAnnounced = true;
      this.handAnnouncePending = true;
    }
  }

  controllerIndex(controller) {
    if (controller === this.controller0) {
      return 0;
    }
    if (controller === this.controller1) {
      return 1;
    }
    return -1;
  }

  isHandSource(index) {
    return index >= 0 && !!(this.inputSources[index] && this.inputSources[index].hand);
  }

  anyHandActive() {
    return this.isHandSource(0) || this.isHandSource(1);
  }

  // Point the shared raycaster along a controller's ray. Hands use the smoothed
  // ray; controllers use their raw pose exactly as before.
  aimRaycaster(controller, raycaster = this.raycaster) {
    const idx = this.controllerIndex(controller);
    const hr = this.isHandSource(idx) ? this.handRays[idx] : null;

    if (hr && hr.init) {
      raycaster.ray.origin.copy(hr.origin);
      raycaster.ray.direction.set(0, 0, -1).applyQuaternion(hr.quat);
      return;
    }
    this.tempMatrix = this.tempMatrix || new THREE.Matrix4();
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);
  }

  isWorldVisible(object) {
    for (let o = object; o; o = o.parent) {
      if (!o.visible) {
        return false;
      }
    }
    return true;
  }

  // Intersect the HUD from the current raycaster ray. Raycaster ignores
  // `visible`, so for hands (which tap empty air to toggle the HUD) hidden
  // buttons must not swallow the pinch.
  pickInteractive(controller) {
    const hits = this.raycaster.intersectObjects(this.interactiveElements);

    if (!this.isHandSource(this.controllerIndex(controller))) {
      return hits;
    }
    const visible = hits.filter((h) => this.isWorldVisible(h.object));

    if (visible.length > 0) {
      return visible;
    }
    // Magnetism: a pinch that lands just outside a button still counts, so
    // small targets (like the mono toggle) are easy to hit with a shaky hand.
    const ray = this.raycaster.ray;
    const margin = 0.05;
    let best = null;

    for (const el of this.interactiveElements) {
      if (!this.isWorldVisible(el)) {
        continue;
      }
      el.updateWorldMatrix(true, false);
      const normal = this.tmpA.set(0, 0, 1).transformDirection(el.matrixWorld);
      const center = this.tmpB.setFromMatrixPosition(el.matrixWorld);
      const denom = normal.dot(ray.direction);

      if (Math.abs(denom) < 1e-4) {
        continue;
      }
      const t = normal.dot(this.tmpC.copy(center).sub(ray.origin)) / denom;

      if (t <= 0) {
        continue;
      }
      const point = ray.origin.clone().addScaledVector(ray.direction, t);
      const local = el.worldToLocal(point.clone());

      if (!el.geometry.boundingBox) {
        el.geometry.computeBoundingBox();
      }
      const bb = el.geometry.boundingBox;
      const dx = Math.max(bb.min.x - local.x, 0, local.x - bb.max.x);
      const dy = Math.max(bb.min.y - local.y, 0, local.y - bb.max.y);
      const d = Math.hypot(dx, dy);

      if (d <= margin && (!best || d < best.d)) {
        best = { d, hit: { object: el, point, distance: t } };
      }
    }
    return best ? [best.hit] : [];
  }

  // True if the pinch that is ending moved the beam enough to count as a drag
  // rather than a tap (so dragging off a thumbnail doesn't select it).
  isSelectDrag(controller) {
    const idx = this.controllerIndex(controller);

    if (!this.isHandSource(idx)) {
      return false;
    }
    this.aimRaycaster(controller, this.dragCheckRaycaster || (this.dragCheckRaycaster = new THREE.Raycaster()));
    return this.dragCheckRaycaster.ray.direction.angleTo(this.selectStartDirs[idx]) > 0.07;
  }

  // Nearest visible HUD / gallery surface under the ray (for the cursor only).
  pickSurface() {
    const roots = [];

    if (this.isVisible) {
      roots.push(this.hudGroup);
    }
    if (this.vrGallery && this.vrGallery.isVisible && this.vrGallery.galleryGroup) {
      roots.push(this.vrGallery.galleryGroup);
    }
    if (!roots.length) {
      return null;
    }
    return this.raycaster.intersectObjects(roots, true)
      .find((h) => h.object.isMesh && this.isWorldVisible(h.object)) || null;
  }

  updateHandRays() {
    for (let i = 0; i < 2; i++) {
      const controller = i === 0 ? this.controller0 : this.controller1;
      const hr = this.handRays[i];

      if (!controller || !this.isHandSource(i) || !controller.visible) {
        hr.init = false;
        continue;
      }
      controller.matrixWorld.decompose(this.tmpA, this.tmpQuat, this.tmpScale);
      if (!hr.init) {
        hr.origin.copy(this.tmpA);
        hr.quat.copy(this.tmpQuat);
        hr.init = true;
        continue;
      }
      // Heavy smoothing for slow/precise aiming, light when sweeping fast
      const alpha = Math.min(1, 0.08 + hr.quat.angleTo(this.tmpQuat) * 10);

      hr.quat.slerp(this.tmpQuat, alpha);
      hr.origin.lerp(this.tmpA, alpha);
    }
  }

  updateHandVisuals() {
    const tint = this.controlsLocked;

    if (!this.showHandModels) {
      for (const model of this.handModels) {
        if (model && model.joints.visible) {
          model.joints.visible = false;
          model.bones.visible = false;
        }
      }
      return;
    }

    this.jointMaterial.color.setHex(tint ? 0xffd9a0 : 0xe6f6ff);
    this.boneMaterial.color.setHex(tint ? 0xe0922f : 0x8fcdea);

    for (let i = 0; i < 2; i++) {
      const model = this.handModels[i];
      const hand = this.hands[i];

      if (!model) {
        continue;
      }
      if (!hand || !this.isHandSource(i)) {
        model.joints.visible = false;
        model.bones.visible = false;
        continue;
      }

      let tracked = 0;

      for (const name of HAND_JOINTS) {
        const joint = hand.joints[name];

        if (joint && joint.visible) {
          const pos = this.jointPositions[name] || (this.jointPositions[name] = new THREE.Vector3());

          joint.getWorldPosition(pos);
          this.jointRadii[name] = Math.max(0.006, joint.jointRadius || 0.008);
          tracked++;
        } else {
          delete this.jointPositions[name];
        }
      }
      model.joints.visible = model.bones.visible = tracked > 0;
      if (!tracked) {
        continue;
      }

      HAND_JOINTS.forEach((name, k) => {
        const pos = this.jointPositions[name];

        if (pos) {
          this.jointScale.setScalar(this.jointRadii[name] * 1.1);
          this.jointMatrix.compose(pos, this.tmpQuat.identity(), this.jointScale);
        } else {
          this.jointMatrix.makeScale(0, 0, 0);
        }
        model.joints.setMatrixAt(k, this.jointMatrix);
      });
      HAND_BONES.forEach(([a, b], k) => {
        const pa = this.jointPositions[a];
        const pb = this.jointPositions[b];

        if (pa && pb) {
          const length = pa.distanceTo(pb);

          this.tmpA.copy(pb).sub(pa);
          this.tmpQuat.setFromUnitVectors(this.unitY, this.tmpA.normalize());
          this.tmpB.copy(pa).add(pb).multiplyScalar(0.5);
          this.jointScale.set(
            Math.min(this.jointRadii[a], this.jointRadii[b]) * 0.8,
            Math.max(0.0001, length),
            Math.min(this.jointRadii[a], this.jointRadii[b]) * 0.8
          );
          this.jointMatrix.compose(this.tmpB, this.tmpQuat, this.jointScale);
        } else {
          this.jointMatrix.makeScale(0, 0, 0);
        }
        model.bones.setMatrixAt(k, this.jointMatrix);
      });
      model.joints.instanceMatrix.needsUpdate = true;
      model.bones.instanceMatrix.needsUpdate = true;
    }
  }

  // World position of a joint; false when the joint isn't currently tracked.
  getJointPosition(index, name, out) {
    const hand = this.hands[index];
    const joint = hand && hand.joints && hand.joints[name];

    if (!joint || !joint.visible) {
      return false;
    }
    joint.getWorldPosition(out);
    return true;
  }

  getPalmPosition(index, out) {
    if (!this.getJointPosition(index, 'wrist', out)) {
      return false;
    }
    if (this.getJointPosition(index, 'middle-finger-phalanx-proximal', this.tmpC)) {
      out.add(this.tmpC).multiplyScalar(0.5);
    }
    return true;
  }

  updateHandGestures(now) {
    if (!this.handGesturesEnabled || !this.anyHandActive()) {
      return;
    }

    this.detectClap(now);

    if (this.controlsLocked) {
      return;
    }

    // Thumb + middle finger (index pinch stays "select"):
    //   quick tap  = play / pause
    //   hold+swipe = left/right seeks, up/down scrolls the gallery
    for (let i = 0; i < 2; i++) {
      const state = this.midPinch[i];

      if (!this.isHandSource(i) ||
          !this.getJointPosition(i, 'thumb-tip', this.tmpA) ||
          !this.getJointPosition(i, 'middle-finger-tip', this.tmpB) ||
          !this.getJointPosition(i, 'index-finger-tip', this.tmpC)) {
        state.down = false;
        state.since = 0;
        continue;
      }
      const middleDist = this.tmpA.distanceTo(this.tmpB);
      const indexDist = this.tmpA.distanceTo(this.tmpC);
      const point = this.tmpA.add(this.tmpB).multiplyScalar(0.5);

      if (!state.down) {
        if (middleDist < 0.018 && indexDist > 0.045) {
          if (!state.since) {
            state.since = now;
          } else if (now - state.since > 90) {
            this.beginMiddleSwipe(state, point, now);
          }
        } else {
          state.since = 0;
        }
      } else if (middleDist > 0.03) {
        this.endMiddleSwipe(state, point, now);
      } else {
        this.updateMiddleSwipe(state, point, now);
      }
    }
  }

  beginMiddleSwipe(state, point, now) {
    state.down = true;
    state.moved = false;
    state.axis = null;
    state.start.copy(point);
    state.startedAt = now;
    state.startTime = this.player.currentTime() || 0;
    state.lastSeek = 0;
    state.lastScrollY = point.y;

    // "Right" for this gesture = the way the viewer is facing, flattened
    const xrCamera = this.renderer.xr.getCamera();
    const fwd = new THREE.Vector3(0, 0, -1);

    xrCamera.matrixWorld.decompose(this.tmpB, this.tmpQuat, this.tmpScale);
    fwd.applyQuaternion(this.tmpQuat);
    fwd.y = 0;
    if (fwd.lengthSq() < 0.0001) {
      fwd.set(0, 0, -1);
    }
    fwd.normalize();
    state.right.set(-fwd.z, 0, fwd.x);
  }

  updateMiddleSwipe(state, point, now) {
    const dx = this.tmpC.copy(point).sub(state.start).dot(state.right);
    const dy = point.y - state.start.y;
    const galleryOpen = !!(this.vrGallery && this.vrGallery.isVisible);

    if (!state.moved) {
      if (Math.hypot(dx, dy) < 0.03) {
        return;
      }
      state.moved = true;
      // Lock to the dominant direction so a wobbly swipe doesn't do both
      state.axis = galleryOpen ? 'v' : (Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v');
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }
      if (!this.isVisible && !galleryOpen && state.axis === 'h') {
        this.show();
      }
    }

    if (state.axis === 'h' && !galleryOpen) {
      const duration = this.player.duration();

      if (!duration || !isFinite(duration) || now - state.lastSeek < 100) {
        return;
      }
      // About 0.4 m of arm travel covers a fifth of the video, bounded for very short/long ones
      const secondsPerMeter = Math.max(30, Math.min(1800, duration / 2));
      const target = Math.max(0, Math.min(duration, state.startTime + dx * secondsPerMeter));

      state.lastSeek = now;
      this.player.currentTime(target);
    } else if (state.axis === 'v' && galleryOpen) {
      const step = point.y - state.lastScrollY;

      state.lastScrollY = point.y;
      // 1:1 with the hand regardless of HUD scale (gallery units are scaled)
      this.vrGallery.handleScroll(step / this.hudGroup.scale.x * this.galleryScrollSign);
    }
  }

  endMiddleSwipe(state, point, now) {
    const wasTap = !state.moved && now - state.startedAt < 500;

    state.down = false;
    state.since = 0;
    if (wasTap && now - this.lastPlayPauseToggle > 400) {
      this.lastPlayPauseToggle = now;
      const wasPaused = this.player.paused();

      if (wasPaused) {
        this.player.play();
      } else {
        this.player.pause();
      }
      this.showToast(wasPaused ? '▶' : '⏸', {
        width: 0.07,
        height: 0.07,
        canvasWidth: 128,
        duration: 700,
        position: point.clone().add(new THREE.Vector3(0, 0.09, 0))
      });
    }
    this.resetAutoHideTimer();
  }

  // Lock / unlock: hold both palms together (~0.45 s), or clap quickly.
  // Tracking usually drops while the hands overlap, so a short loss of
  // tracking right after they were close still counts as "together".
  detectClap(now) {
    const st = this.clapState;

    if (!this.isHandSource(0) || !this.isHandSource(1)) {
      this.clapHistory.length = 0;
      st.since = 0;
      st.armed = true;
      return;
    }
    const left = new THREE.Vector3();
    const right = new THREE.Vector3();
    const busy = this.pinching[0] || this.pinching[1] || this.midPinch[0].down || this.midPinch[1].down;

    if (!this.getPalmPosition(0, left) || !this.getPalmPosition(1, right)) {
      if (st.since && st.armed && st.lastD < 0.2 && now - st.lastSeen < 350 && now - st.since > 450) {
        this.triggerClap(now);
      } else if (now - st.lastSeen >= 350) {
        st.since = 0;
      }
      return;
    }
    const dist = left.distanceTo(right);

    st.lastD = dist;
    st.lastSeen = now;

    if (dist > 0.26) {
      st.armed = true;
      st.since = 0;
    } else if (dist < 0.14 && st.armed && !busy) {
      if (!st.since) {
        st.since = now;
      } else if (now - st.since > 450) {
        this.triggerClap(now);
        return;
      }
    } else if (dist > 0.17) {
      st.since = 0;
    }

    // Fast clap: closing quickly from clearly apart
    this.clapHistory.push({ t: now, d: dist });
    while (this.clapHistory.length && now - this.clapHistory[0].t > 600) {
      this.clapHistory.shift();
    }
    let apart = this.clapHistory[0];

    for (const h of this.clapHistory) {
      if (h.d > apart.d) {
        apart = h;
      }
    }
    const dt = (now - apart.t) / 1000;

    if (st.armed && !busy && dist < 0.16 && apart.d > 0.3 && dt > 0.03 && (apart.d - dist) / dt > 0.9) {
      this.triggerClap(now);
    }
  }

  triggerClap(now) {
    this.lastClap = now;
    this.clapHistory.length = 0;
    this.clapState.armed = false; // must separate the hands before the next toggle
    this.clapState.since = 0;
    this.toggleLock();
  }

  isLocked() {
    return this.controlsLocked;
  }

  toggleLock() {
    if (this.controlsLocked) {
      this.unlockControls();
    } else {
      this.lockControls();
    }
  }

  lockControls() {
    if (this.controlsLocked) {
      return;
    }
    this.controlsLocked = true;
    this.gestureDrag = null;
    this.isDraggingOrientation = false;
    this.isDraggingScrub = false;
    this.draggingController = null;
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    this.hide();
    this.showToast('🔒 Locked — hold palms together to unlock');
    if (this.onLockChange) {
      this.onLockChange(true);
    }
  }

  unlockControls() {
    if (!this.controlsLocked) {
      return;
    }
    this.controlsLocked = false;
    this.showToast('🔓 Unlocked');
    if (this.onLockChange) {
      this.onLockChange(false);
    }
    this.show();
    this.resetAutoHideTimer();
  }

  // Small floating message in front of the viewer; independent of the HUD so
  // it shows while the HUD is hidden/locked.
  showToast(text, options = {}) {
    if (!this.isInXRSession) {
      return;
    }
    this.removeToast();

    const height = options.height || 0.055;
    const canvas = document.createElement('canvas');
    let ctx = canvas.getContext('2d');
    const fontPx = 56;
    const canvasHeight = 100;

    canvas.height = canvasHeight;
    if (options.canvasWidth) {
      canvas.width = canvas.height = options.canvasWidth; // square glyph
    } else {
      // Size the pill to the text so nothing is clipped at the sides
      ctx.font = `${fontPx}px Arial`;
      canvas.width = Math.ceil(ctx.measureText(text).width) + 90;
    }
    const width = options.canvasWidth ? height : height * canvas.width / canvasHeight;

    ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(20, 20, 20, 0.8)';
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2);
    } else {
      ctx.rect(0, 0, canvas.width, canvas.height);
    }
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = options.canvasWidth ? `${Math.round(canvas.height * 0.55)}px Arial` : `${fontPx}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 3);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);

    mesh.renderOrder = 999;
    mesh.frustumCulled = false;
    mesh.layers.set(0);
    mesh.layers.enable(1);
    mesh.layers.enable(2);

    const xrCamera = this.renderer.xr.getCamera();
    const head = new THREE.Vector3().setFromMatrixPosition(xrCamera.matrixWorld);

    if (options.position) {
      mesh.position.copy(options.position);
    } else {
      // Low in the field of view, well inside arm's reach, so it never sits
      // on top of what you're watching.
      xrCamera.matrixWorld.decompose(this.tmpA, this.tmpQuat, this.tmpScale);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.tmpQuat);

      dir.y = 0;
      if (dir.lengthSq() < 0.0001) {
        dir.set(0, 0, -1);
      }
      dir.normalize();
      mesh.position.copy(head).addScaledVector(dir, 0.7);
      mesh.position.y = head.y - 0.32;
    }
    mesh.lookAt(head);

    this.scene.add(mesh);
    this.toast = { mesh, texture, until: performance.now() + (options.duration || 1400) };
  }

  removeToast() {
    if (!this.toast) {
      return;
    }
    this.scene.remove(this.toast.mesh);
    this.toast.mesh.geometry.dispose();
    this.toast.mesh.material.dispose();
    this.toast.texture.dispose();
    this.toast = null;
  }

  updateToast(now) {
    if (!this.toast) {
      return;
    }
    const remaining = this.toast.until - now;

    if (remaining <= 0) {
      this.removeToast();
    } else if (remaining < 300) {
      this.toast.mesh.material.opacity = remaining / 300;
    }
  }

  // Pinch on empty space: a quick tap toggles the HUD, a horizontal drag seeks.
  beginGestureDrag(controller) {
    this.aimRaycaster(controller);
    const dir = this.raycaster.ray.direction;

    const gallery = this.vrGallery && this.vrGallery.isVisible ? this.vrGallery : null;

    this.gestureDrag = {
      controller,
      gallery,
      startYaw: Math.atan2(dir.x, -dir.z),
      startTime: this.player.currentTime() || 0,
      startedAt: performance.now(),
      lastSeek: 0,
      moved: false
    };
  }

  updateGestureDrag() {
    const gd = this.gestureDrag;

    if (!gd) {
      return;
    }
    if (this.controlsLocked) {
      this.gestureDrag = null;
      return;
    }
    if (gd.gallery) {
      return; // gallery open: scrolling is the thumb + middle finger swipe, not index pinch
    }
    this.aimRaycaster(gd.controller);

    const dir = this.raycaster.ray.direction;
    let delta = Math.atan2(dir.x, -dir.z) - gd.startYaw;

    delta = Math.atan2(Math.sin(delta), Math.cos(delta));

    const deadZone = 0.05; // ~3 degrees before a tap becomes a drag

    if (!gd.moved) {
      if (Math.abs(delta) < deadZone) {
        return;
      }
      gd.moved = true;
      if (this.hideTimeout) {
        clearTimeout(this.hideTimeout);
        this.hideTimeout = null;
      }
      if (!this.isVisible) {
        this.show();
      }
    }

    const duration = this.player.duration();
    const now = performance.now();

    if (!duration || !isFinite(duration) || now - gd.lastSeek < 100) {
      return;
    }
    // Longer videos seek faster per degree of hand sweep
    const secondsPerRadian = Math.max(30, Math.min(600, duration / 6));
    const effective = delta - Math.sign(delta) * deadZone;
    const target = Math.max(0, Math.min(duration, gd.startTime + effective * secondsPerRadian));

    gd.lastSeek = now;
    this.player.currentTime(target);
  }

  endGestureDrag() {
    const gd = this.gestureDrag;

    this.gestureDrag = null;
    if (gd && !gd.gallery && !gd.moved && performance.now() - gd.startedAt < 450) {
      if (this.isVisible) {
        this.hide();
      } else {
        this.show();
        this.resetAutoHideTimer();
      }
    }
  }

  setupInteraction() {
    // For VR controllers and hands
    if (this.renderer.xr) {
      // Controller 0 (typically right hand on Quest)
      const controller0 = this.renderer.xr.getController(0);
      const controllerGrip0 = this.renderer.xr.getControllerGrip(0);
      if (controller0) {
        controller0.addEventListener('connected', (e) => this.onInputSourceConnected(0, e.data));
        controller0.addEventListener('disconnected', () => this.onInputSourceConnected(0, null));
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

      if (controller1) {
        controller1.addEventListener('connected', (e) => this.onInputSourceConnected(1, e.data));
        controller1.addEventListener('disconnected', () => this.onInputSourceConnected(1, null));
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

      this.setupHandVisuals();
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
    const idx = this.controllerIndex(controller);

    if (idx >= 0) {
      this.pinching[idx] = true;
    }
    if (this.controlsLocked) {
      return;
    }

    this.aimRaycaster(controller);
    if (idx >= 0) {
      this.selectStartDirs[idx].copy(this.raycaster.ray.direction);
    }

    const intersects = this.pickInteractive(controller);

    if (intersects.length === 0 && this.handGesturesEnabled && this.isHandSource(idx) && !this.gestureDrag) {
      this.beginGestureDrag(controller);
    }

    if (intersects.length > 0) {
      const obj = intersects[0].object;

      if (obj.userData.type === 'orientation-handle') {
        this.isDraggingOrientation = true;
        this.draggingController = controller; // Store which controller is dragging
        this.dragStartPoint = intersects[0].point.clone();
        this.dragStartRotation = this.orientationOffset.clone();
        // Cancel auto-hide while dragging
        if (this.hideTimeout) {
          clearTimeout(this.hideTimeout);
          this.hideTimeout = null;
        }
      } else if (obj.userData.type === 'scrub' || obj.userData.type === 'scrub-handle') {
        this.isDraggingScrub = true;
        this.draggingController = controller;
        this.scrubDragStartX = intersects[0].point.x; // Track where drag started
        // Cancel auto-hide while dragging
        if (this.hideTimeout) {
          clearTimeout(this.hideTimeout);
          this.hideTimeout = null;
        }
      }
    }
  }

  onSelectEnd(event) {
    const idx = this.controllerIndex(event.target);

    if (idx >= 0) {
      this.pinching[idx] = false;
    }
    if (this.gestureDrag && this.gestureDrag.controller === event.target) {
      this.endGestureDrag();
    }
    // The other hand releasing must not cancel this hand's drag
    if (this.draggingController && this.draggingController !== event.target) {
      return;
    }
    this.isDraggingOrientation = false;
    this.isDraggingScrub = false;
    this.draggingController = null;
    this.dragStartDirection = null; // Clear the start direction for orientation drag
    // Restart auto-hide timer after interaction ends
    this.resetAutoHideTimer();
  }

  onSelect(event) {
    const controller = event.target;

    if (this.controlsLocked) {
      return;
    }
    this.aimRaycaster(controller);

    // Orientation dragging is handled by updateControllerDragging() using direction tracking
    // Don't handle it here to avoid conflicts
    if (this.isDraggingOrientation) {
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
    const intersects = this.pickInteractive(controller);

    if (intersects.length > 0) {
      this.handleInteraction(intersects[0].object, intersects[0].point);
    }
  }

  onSqueezeStart(event) {
    if (this.controlsLocked) {
      return;
    }
    // Grip squeeze toggles the HUD visibility
    if (this.hudGroup) {
      if (this.isVisible) {
        this.hide();
      } else {
        this.show(true); // Force show even if not in XR (though we should be)
        this.resetAutoHideTimer();
      }
    }
  }

  onSqueezeEnd(event) {
    // Squeeze end - could be used for other interactions
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
      this.orientationOffset.set(0, 0, 0, 'YXZ');
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

    case 'projection-menu':
      // Toggle projection menu visibility
      this.toggleProjectionMenu();
      break;

    case 'projection-option': {
      // Select a projection from the menu. Empty projectionId means an
      // unfilled scroll slot (last page with fewer than itemsPerPage
      // items) — ignore the click instead of clearing the projection.
      const selectedProjection = object.userData.projectionId;

      if (!selectedProjection) {
        break;
      }
      this.setProjection(selectedProjection);
      this.onProjectionChange(selectedProjection);
      this.hideProjectionMenu();
      break;
    }

    case 'projection-scroll':
      this.scrollProjectionMenu(object.userData.scrollDir || 0);
      break;

    case 'help':
      this.helpVisible = !this.helpVisible;
      break;

    case 'favorite':
      if (this.onFavorite) {
        this.onFavorite();
      }
      break;

    case 'force-mono':
      // Toggle force mono state (persists for VR session duration)
      this.forceMonoEnabled = !this.forceMonoEnabled;
      this.updateForceMonoButton();
      if (this.onForceMonoToggle) {
        this.onForceMonoToggle(this.forceMonoEnabled);
      }
      break;
    }
  }

  // Update force mono button visual state
  updateForceMonoButton() {
    if (!this.forceMonoBtn) return;

    // Find the button mesh and label mesh
    const btnMesh = this.forceMonoBtn.children.find(c => c.userData && c.userData.type === 'force-mono');
    const labelMesh = this.forceMonoBtn.children.find(c => c.material && c.material.map);

    if (btnMesh) {
      // Update button color based on state
      const activeColor = 0x00aa66; // Green when active
      const inactiveColor = 0x2a3a5a; // Dark blue when inactive
      btnMesh.material.color.setHex(this.forceMonoEnabled ? activeColor : inactiveColor);
      btnMesh.userData.baseColor = this.forceMonoEnabled ? activeColor : inactiveColor;
    }

    if (labelMesh) {
      // Update the label to show current state - larger icon for visibility
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');

      // Draw monocle-style icon - single eye symbol
      ctx.fillStyle = this.forceMonoEnabled ? '#00ff88' : '#ffffff';
      ctx.font = 'bold 48px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Use filled circle for active, outlined for inactive
      ctx.fillText(this.forceMonoEnabled ? '●' : '○', 32, 32);

      const newTexture = new THREE.CanvasTexture(canvas);
      if (labelMesh.material.map) {
        labelMesh.material.map.dispose();
      }
      labelMesh.material.map = newTexture;
      labelMesh.material.needsUpdate = true;
    }
  }

  // Get force mono state
  getForceMonoEnabled() {
    return this.forceMonoEnabled;
  }

  // Set force mono state (for external control)
  setForceMonoEnabled(enabled) {
    this.forceMonoEnabled = enabled;
    this.updateForceMonoButton();
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
    if (isNaN(seconds) || !isFinite(seconds)) {
      return '0:00';
    }

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
    // Raycast from camera center (gaze-based)
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactiveElements);

    // Reset all interactive elements to base color first
    // (Controller highlighting is done separately in updateControllerRays)
    this.interactiveElements.forEach(el => {
      // Don't reset if controller is highlighting this element
      if (!el.userData.controllerHighlighted && el.userData.baseColor !== undefined) {
        el.material.color.setHex(el.userData.baseColor);
      }
    });

    if (intersects.length > 0) {
      const obj = intersects[0].object;

      // DON'T highlight projection menu items via gaze - only controllers should do that
      // This prevents head movement from changing highlights
      if (obj.userData.type === 'projection-option' || obj.userData.type === 'projection-scroll') {
        // Just update cursor position, no highlight
        this.cursorHover.material.opacity = 0.3;
        this.cursorDot.material.color.setHex(0x00ffff);
        const cursorPos = intersects[0].point.clone();

        this.camera.worldToLocal(cursorPos);
        this.cursor.position.copy(cursorPos);
        return;
      }

      // For other elements, show hover state
      this.cursorHover.material.opacity = 0.8;
      this.cursorDot.material.color.setHex(0x00ff00);

      // Highlight the hovered element (except projection options)
      if (obj.userData.baseColor !== undefined && !obj.userData.controllerHighlighted) {
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
    }
  }

  // Refresh all layer masks to ensure proper stereo rendering
  // Use explicit layers 0, 1, 2 for WebXR compatibility
  refreshLayers() {
    this.hudGroup.traverse((obj) => {
      if (obj.isMesh || obj.isGroup) {
        // Set layer 0 first, then enable 1 and 2 for stereo
        obj.layers.set(0);
        obj.layers.enable(1);
        obj.layers.enable(2);
      }
    });
    if (this.cursor) {
      this.cursor.traverse((obj) => {
        if (obj.isMesh || obj.isGroup) {
          obj.layers.set(0);
          obj.layers.enable(1);
          obj.layers.enable(2);
        }
      });
    }
  }

  update() {
    const now = performance.now();

    this.updateToast(now);
    if (this.isInXRSession) {
      this.updateHandRays();
      this.updateHandVisuals();
      this.updateHandGestures(now);
      this.updateGestureDrag();
      if (this.handHint) {
        this.handHint.visible = this.helpVisible && this.anyHandActive();
      }
      if (this.helpBtn) {
        this.helpBtn.visible = this.anyHandActive();
      }
      if (this.handAnnouncePending && !this.controlsLocked) {
        // First time hands show up: surface the HUD (and its hint) so the user
        // can learn the gestures without ever touching a controller.
        this.handAnnouncePending = false;
        this.show();
        if (this.autoHideDelay > 0) {
          clearTimeout(this.hideTimeout);
          this.hideTimeout = setTimeout(() => this.hide(), Math.max(this.autoHideDelay, 12000));
        }
      }
    }

    // Poll gamepad inputs (joysticks, buttons)
    this.pollGamepads();

    // Always update controller rays even when HUD is hidden (so user can see where they're pointing)
    this.updateControllerRays();

    // Handle continuous dragging from controllers
    this.updateControllerDragging();

    if (!this.isVisible) {
      return;
    }

    // Refresh layers every frame to prevent double vision
    // This ensures HUD is always visible to both eyes identically
    // The overhead is minimal compared to the rendering cost
    this.refreshLayers();

    this.updateScrubBar();
    this.updateTimeDisplay();
    this.updateCursor();

    // HUD stays FIXED in world space at the video content orientation
    // It does NOT follow the camera/head - user must turn their head to see it
    // CRITICAL: Do NOT use camera.position for HUD position - in WebXR the camera
    // position can differ per-eye which causes double vision issues

    // Calculate the direction based ONLY on the orientation offset (where video is pointing)
    const forward = new THREE.Vector3(0, 0, -1);

    // Apply orientation offset to get the direction video is facing
    const orientationQuat = new THREE.Quaternion();
    orientationQuat.setFromEuler(new THREE.Euler(this.orientationOffset.x, this.orientationOffset.y, 0, 'YXZ'));
    forward.applyQuaternion(orientationQuat);

    // Project forward onto XZ plane and normalize to maintain constant distance
    // This prevents HUD from getting closer when looking up/down
    const forwardXZ = new THREE.Vector2(forward.x, forward.z);
    const xzLength = forwardXZ.length();
    if (xzLength > 0.001) {
      forwardXZ.normalize();
    } else {
      // Looking straight up/down, default to forward
      forwardXZ.set(0, -1);
    }

    // Position HUD at a FIXED world position - use constant height, not camera height
    // This prevents any per-eye differences that could cause double vision
    const fixedHeight = this.hudAnchorY; // Fixed in space, set from head height when shown

    this.hudGroup.position.set(
      forwardXZ.x * this.effectiveHudDistance,
      fixedHeight,
      forwardXZ.y * this.effectiveHudDistance
    );

    // Make HUD face the origin (where user is standing)
    this.hudGroup.lookAt(0, fixedHeight, 0);
  }

  updateControllerDragging() {
    if (!this.isInXRSession) {
      return;
    }
    if (!this.draggingController) {
      return;
    } // Only update if we have an active drag

    const controller = this.draggingController;

    this.aimRaycaster(controller);

    // Handle orientation dragging with 1:1 cursor tracking
    if (this.isDraggingOrientation) {
      // Get current controller direction
      const currentDirection = this.raycaster.ray.direction.clone().normalize();

      // If we don't have a start direction yet, store it
      if (!this.dragStartDirection) {
        this.dragStartDirection = currentDirection.clone();
        this.dragStartRotation = this.orientationOffset.clone();
      }

      const startDir = this.dragStartDirection;
      const currDir = currentDirection;

      // Project both directions onto the horizontal plane for yaw
      const startHorizontal = new THREE.Vector3(startDir.x, 0, startDir.z).normalize();
      const currHorizontal = new THREE.Vector3(currDir.x, 0, currDir.z).normalize();

      // Calculate yaw difference (rotation around Y axis)
      const yawDiff = Math.atan2(currHorizontal.x, currHorizontal.z) - Math.atan2(startHorizontal.x, startHorizontal.z);

      // Calculate pitch difference (rotation around X axis)
      const startPitch = Math.asin(Math.max(-1, Math.min(1, startDir.y)));
      const currPitch = Math.asin(Math.max(-1, Math.min(1, currDir.y)));
      const pitchDiff = currPitch - startPitch;

      // Apply 1:1 mapping - controller movement directly controls orientation
      // Positive yaw diff (moving right) should increase offset to move content right
      const newYaw = this.dragStartRotation.y + yawDiff;
      const newPitch = this.dragStartRotation.x + pitchDiff;

      // Clamp vertical rotation
      const clampedPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, newPitch));

      // Create new Euler with YXZ order to prevent horizon roll
      // Z (roll) is always 0 to maintain horizon alignment
      this.orientationOffset.set(clampedPitch, newYaw, 0, 'YXZ');

      this.onOrientationChange(this.orientationOffset);
    }

    // Handle scrub dragging - project onto scrub track plane
    if (this.isDraggingScrub) {
      // Create a plane at the scrub track position
      const trackWorldPos = new THREE.Vector3();

      this.scrubTrack.getWorldPosition(trackWorldPos);

      const trackPlane = new THREE.Plane();
      const trackNormal = new THREE.Vector3(0, 0, 1);

      trackNormal.applyQuaternion(this.hudGroup.quaternion);
      trackPlane.setFromNormalAndCoplanarPoint(trackNormal, trackWorldPos);

      // Intersect ray with track plane
      const intersection = new THREE.Vector3();

      if (this.raycaster.ray.intersectPlane(trackPlane, intersection)) {
        const localPoint = this.scrubTrack.worldToLocal(intersection.clone());
        const progress = (localPoint.x + this.scrubTrackWidth / 2) / this.scrubTrackWidth;
        const clampedProgress = Math.max(0, Math.min(1, progress));

        if (this.player.duration()) {
          this.player.currentTime(this.player.duration() * clampedProgress);
        }
      }
    }
  }

  updateControllerRays() {
    // Clear all controller highlighting flags first
    this.interactiveElements.forEach(el => {
      el.userData.controllerHighlighted = false;
    });

    // Check both controllers and show rays when in XR session
    const controllers = [this.controller0, this.controller1];
    const rays = [this.ray0, this.ray1];

    for (let i = 0; i < controllers.length; i++) {
      const controller = controllers[i];
      const ray = rays[i];
      const cursor = this.handCursors[i];

      if (cursor) {
        cursor.visible = false;
      }
      if (this.beams[i]) {
        this.beams[i].visible = false;
      }
      if (!controller || !ray) {
        continue;
      }

      // Only show rays when in XR session, and never while controls are locked
      if (!this.isInXRSession || this.controlsLocked) {
        ray.visible = false;
        continue;
      }

      const isHand = this.isHandSource(i);
      const beam = this.beams[i];

      this.aimRaycaster(controller);

      // Check for intersections with HUD elements (if visible)
      const intersects = (this.isVisible || isHand) ? this.pickInteractive(controller) : [];

      if (isHand) {
        // Hands: a beam along the smoothed ray plus a cursor on whatever it
        // hits (buttons, the panel behind them, or the gallery grid).
        ray.visible = false;

        const hr = this.handRays[i];

        const controlsShown = this.isVisible || !!(this.vrGallery && this.vrGallery.isVisible);

        if (!hr.init || !beam || !controlsShown) {
          if (beam) {
            beam.visible = false;
          }
        } else {
          const surface = this.pickSurface();
          const candidates = [intersects[0], surface].filter(Boolean).sort((x, y) => x.distance - y.distance);
          const best = candidates[0] || null;
          const length = best ? best.distance : 2.5;
          const pinching = this.pinching[i];
          const radius = (0.0018 + length * 0.0016) * (pinching ? 1.6 : 1);

          beam.visible = true;
          beam.position.copy(hr.origin).addScaledVector(this.raycaster.ray.direction, 0.04);
          beam.quaternion.copy(hr.quat);
          beam.scale.set(radius, radius, Math.max(0.02, length - 0.04));
          beam.material.color.setHex(pinching ? 0x00ff88 : 0x66ddff);
          beam.material.opacity = pinching ? 0.95 : (best ? 0.75 : 0.3);

          if (best && cursor) {
            cursor.visible = true;
            cursor.position.copy(best.point);
            best.object.getWorldQuaternion(cursor.quaternion);
            cursor.scale.setScalar(Math.max(0.35, best.distance * 0.4) * (pinching ? 0.6 : 1));
            cursor.material.color.setHex(pinching ? 0x00ff88 : 0xffffff);
            cursor.children[0].material.color.setHex(pinching ? 0x00ff88 : 0x66ddff);
          }
        }
      } else {
        // Always show ray in XR, adjust length based on intersection
        ray.visible = true;
      }

      if (intersects.length > 0) {
        if (!isHand) {
          // Shorten ray to intersection point and make it brighter
          ray.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -intersects[0].distance)]);
          ray.material.opacity = 0.8; // Brighter when hitting UI
        }

        // Highlight the element being pointed at
        const obj = intersects[0].object;

        if (obj.userData.baseColor !== undefined) {
          obj.material.color.setHex(obj.userData.hoverColor || 0x00ffff);
          obj.userData.controllerHighlighted = true;
        }
      } else if (!isHand) {
        // Default length and dimmer when not hitting anything
        ray.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)]);
        ray.material.opacity = 0.3;
      }
    }
  }

  pollGamepads() {
    if (!this.isInXRSession || this.controlsLocked) {
      return;
    }

    const session = this.renderer.xr.getSession();

    if (!session) {
      return;
    }

    const now = Date.now();

    // Get gamepads from XR input sources
    for (const source of session.inputSources) {
      if (!source.gamepad) {
        continue;
      }

      const gamepad = source.gamepad;
      const axes = gamepad.axes;
      const buttons = gamepad.buttons;

      // Thumbstick: axes[2] = X (left/right), axes[3] = Y (up/down)
      // For Quest controllers, left stick might be axes[0,1], right axes[2,3]
      const thumbstickX = axes.length > 2 ? axes[2] : (axes.length > 0 ? axes[0] : 0);
      const thumbstickY = axes.length > 3 ? axes[3] : (axes.length > 1 ? axes[1] : 0);

      // Joystick left/right - video seek (with throttling)
      if (Math.abs(thumbstickX) > 0.5 && now - this.lastJoystickSeek > 200) {
        const seekAmount = thumbstickX * this.joystickSeekSpeed;
        const newTime = Math.max(0, Math.min(
          this.player.duration() || 0,
          (this.player.currentTime() || 0) + seekAmount
        ));

        this.player.currentTime(newTime);
        this.lastJoystickSeek = now;
        this.resetAutoHideTimer();
      }

      // Joystick up/down - gallery scroll
      if (Math.abs(thumbstickY) > 0.3 && this.vrGallery && this.vrGallery.isVisible) {
        // Joystick down (negative Y) scrolls down, joystick up (positive Y) scrolls up
        this.vrGallery.scroll(thumbstickY * this.joystickScrollSpeed);
        this.resetAutoHideTimer();
      }

      // A button (index 4 on Quest) - Play/Pause
      // Button layout: 0=trigger, 1=squeeze, 2=?, 3=thumbstick press, 4=A/X, 5=B/Y
      const aButtonIndex = 4;

      if (buttons.length > aButtonIndex) {
        const aButton = buttons[aButtonIndex];

        if (aButton.pressed && !this.aButtonWasPressed) {
          // A button just pressed - toggle play/pause
          if (this.player.paused()) {
            this.player.play();
          } else {
            this.player.pause();
          }
          this.resetAutoHideTimer();
        }
        this.aButtonWasPressed = aButton.pressed;
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

  show(force = false) {
    if (this.controlsLocked) {
      return;
    }
    // Only show if in XR session or forced
    if (!this.isInXRSession && !force) {
      return;
    }
    if (!this.isVisible && this.isInXRSession) {
      const head = this.renderer.xr.getCamera().matrixWorld.elements[13];

      // ~30cm below eye level: below the video's line of sight, easy to reach
      this.hudAnchorY = head > 0.3 ? Math.max(0.5, Math.min(2.5, head - 0.3)) : 1.2;
    }
    this.isVisible = true;
    this.hudGroup.visible = true;
    this.cursor.visible = true;

    // Ensure all HUD elements have proper layers for stereo rendering
    // Use explicit layers 0, 1, 2 instead of enableAll for WebXR compatibility
    this.hudGroup.traverse((obj) => {
      if (obj.isMesh || obj.isGroup) {
        obj.layers.set(0);
        obj.layers.enable(1);
        obj.layers.enable(2);
      }
    });
    this.cursor.traverse((obj) => {
      if (obj.isMesh || obj.isGroup) {
        obj.layers.set(0);
        obj.layers.enable(1);
        obj.layers.enable(2);
      }
    });
  }

  hide() {
    this.isVisible = false;
    this.hudGroup.visible = false;
    this.cursor.visible = false;
    // Also hide the VR gallery when HUD hides
    if (this.vrGallery && this.vrGallery.isVisible) {
      this.vrGallery.hide();
    }
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
    this.removeToast();
    this.hands.forEach((hand) => hand && this.scene.remove(hand));
    this.handCursors.forEach((cursor) => {
      if (cursor) {
        this.scene.remove(cursor);
        cursor.geometry.dispose();
        cursor.material.dispose();
      }
    });
    this.handModels.forEach((model) => {
      if (model) {
        this.scene.remove(model.joints);
        this.scene.remove(model.bones);
        model.joints.dispose();
        model.bones.dispose();
      }
    });
    this.beams.forEach((beam) => {
      if (beam) {
        this.scene.remove(beam);
        beam.material.dispose();
      }
    });
    if (this.beamGeometry) {
      this.beamGeometry.dispose();
    }
    this.jointMaterial.dispose();
    this.boneMaterial.dispose();
    if (this.handHintTexture) {
      this.handHintTexture.dispose();
    }

    // Clean up textures
    if (this.timeTexture) {
      this.timeTexture.dispose();
    }

    // Clean up geometries and materials
    this.hudGroup.traverse((obj) => {
      if (obj.geometry) {
        obj.geometry.dispose();
      }
      if (obj.material) {
        if (obj.material.map) {
          obj.material.map.dispose();
        }
        obj.material.dispose();
      }
    });
  }
}

export default VRHUD;

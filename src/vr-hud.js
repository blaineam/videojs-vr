/* global document */
/* eslint-disable no-inline-comments, newline-after-var, curly, no-console, function-paren-newline, no-multi-spaces */
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
    this.onProjectionChange = options.onProjectionChange || (() => {});
    this.onFavorite = options.onFavorite || null; // Optional favorite callback
    this.onForceMonoToggle = options.onForceMonoToggle || null; // Callback for force mono toggle

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
      { id: 'SBS_MONO', label: 'Side by Side' }
    ];
    this.currentProjection = '180';
    this.projectionMenuVisible = false;

    // HUD configuration (can be overridden by options)
    // Reduced distance from 4 to 1.5 to minimize stereo parallax and double vision
    this.hudDistance = options.hudDistance !== undefined ? options.hudDistance : 1.5;
    this.hudHeight = options.hudHeight !== undefined ? options.hudHeight : 1.5;
    this.hudScale = options.hudScale !== undefined ? options.hudScale : 0.015;
    this.autoHideDelay = options.autoHideDelay !== undefined ? options.autoHideDelay : 10000;

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

    this.createCursor();
    this.createControlPanel();
    this.createScrubBar();
    this.createNavigationButtons();
    this.createProjectionMenu();

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

    // Menu background - dark semi-transparent (no blue tint)
    const menuWidth = 0.5;
    const menuHeight = this.projectionModes.length * 0.08 + 0.15;
    const cornerRadius = 0.04;

    const menuShape = this.createRoundedRectShape(menuWidth, menuHeight, cornerRadius);
    const menuGeometry = new THREE.ShapeGeometry(menuShape);
    menuGeometry.translate(-menuWidth / 2, -menuHeight / 2, 0);
    const menuMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a, // Neutral dark gray
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

    // Create projection option buttons
    this.projectionOptionButtons = [];
    const startY = menuHeight / 2 - 0.12;

    this.projectionModes.forEach((mode, index) => {
      const btnY = startY - index * 0.08;

      // Button background with rounded corners for liquid glass style
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

      btnMesh.position.set(0, btnY, 0.002);
      btnMesh.userData.interactive = true;
      btnMesh.userData.type = 'projection-option';
      btnMesh.userData.projectionId = mode.id;
      btnMesh.userData.baseColor = 0x1a1a3a;
      btnMesh.userData.hoverColor = 0x004466; // Darker cyan - keeps white text readable
      this.projectionMenu.add(btnMesh);
      this.interactiveElements.push(btnMesh);
      this.projectionOptionButtons.push({ mesh: btnMesh, id: mode.id });

      // Button label
      const labelCanvas = document.createElement('canvas');

      labelCanvas.width = 256;
      labelCanvas.height = 32;
      const labelCtx = labelCanvas.getContext('2d');

      labelCtx.fillStyle = '#ffffff';
      labelCtx.font = 'bold 22px Arial';
      labelCtx.textAlign = 'center';
      labelCtx.textBaseline = 'middle';
      labelCtx.fillText(mode.label, 128, 16);

      const labelTexture = new THREE.CanvasTexture(labelCanvas);
      const labelMaterial = new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true });
      const labelGeometry = new THREE.PlaneGeometry(0.35, 0.04);
      const labelMesh = new THREE.Mesh(labelGeometry, labelMaterial);

      labelMesh.position.set(0, btnY, 0.003);
      this.projectionMenu.add(labelMesh);
    });

    // Position menu above the projection button - raised higher to avoid clipping
    this.projectionMenu.position.set(0.8, 0.55, 0.02);

    this.controlPanel.add(this.projectionMenu);
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

  setupInteraction() {
    // For VR controllers and hands
    if (this.renderer.xr) {
      // Controller 0 (typically right hand on Quest)
      const controller0 = this.renderer.xr.getController(0);
      const controllerGrip0 = this.renderer.xr.getControllerGrip(0);
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
    this.isDraggingOrientation = false;
    this.isDraggingScrub = false;
    this.draggingController = null;
    this.dragStartDirection = null; // Clear the start direction for orientation drag
    // Restart auto-hide timer after interaction ends
    this.resetAutoHideTimer();
  }

  onSelect(event) {
    const controller = event.target;

    this.tempMatrix = new THREE.Matrix4();
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);

    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

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
    const intersects = this.raycaster.intersectObjects(this.interactiveElements);

    if (intersects.length > 0) {
      this.handleInteraction(intersects[0].object, intersects[0].point);
    }
  }

  onSqueezeStart(event) {
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

    console.log('[VR HUD] handleInteraction type:', type);

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
      console.log('[VR HUD] Gallery button clicked');
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

    case 'projection-option':
      // Select a projection from the menu
      const selectedProjection = object.userData.projectionId;

      console.log('[VR HUD] Selecting projection:', selectedProjection);
      this.setProjection(selectedProjection);
      this.onProjectionChange(selectedProjection);
      this.hideProjectionMenu();
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
      console.log('[VR HUD] Force Mono:', this.forceMonoEnabled ? 'ON' : 'OFF');
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
      if (obj.userData.type === 'projection-option') {
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
    const fixedHeight = 0.7; // Fixed height above floor level

    this.hudGroup.position.set(
      forwardXZ.x * this.hudDistance,
      fixedHeight,
      forwardXZ.y * this.hudDistance
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

    this.tempMatrix = this.tempMatrix || new THREE.Matrix4();
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);

    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

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

      if (!controller || !ray) {
        continue;
      }

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

          // Highlight the element being pointed at by controller
          const obj = intersects[0].object;

          if (obj.userData.baseColor !== undefined) {
            obj.material.color.setHex(obj.userData.hoverColor || 0x00ffff);
            obj.userData.controllerHighlighted = true;
          }
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

  pollGamepads() {
    if (!this.isInXRSession) {
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
    // Only show if in XR session or forced
    if (!this.isInXRSession && !force) {
      return;
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

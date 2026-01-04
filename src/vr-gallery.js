/* global document */
/* eslint-disable no-inline-comments, newline-after-var, curly, no-console, function-paren-newline, no-multi-spaces */
import * as THREE from 'three';

/**
 * VR Gallery - In-VR media browser with scrollable thumbnails
 * Allows users to browse and select VR media while in VR mode
 */
class VRGallery {
  constructor(options) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.renderer = options.renderer;

    // Callbacks
    this.onMediaSelect = options.onMediaSelect || (() => {});
    this.getSrc = options.getSrc || null; // Function to resolve resource paths to blob URLs

    // Gallery configuration
    // Reduced distance from 3.5 to 1.5 to minimize stereo parallax
    this.galleryDistance = 1.5;
    this.thumbnailWidth = 0.5;
    this.thumbnailHeight = 0.3;
    this.thumbnailSpacing = 0.08;
    this.columns = 4;
    this.visibleRows = 3;
    this.scrollPosition = 0;
    this.maxScroll = 0;

    // Clipping region for thumbnail overflow
    this.clipMinY = 0;
    this.clipMaxY = 0;

    // THREE.js clipping planes for proper overflow hidden effect
    // These will be set in createGalleryFrame after dimensions are known
    this.clippingPlanes = [];

    // Track failed loads to prevent infinite retries
    this.failedLoads = new Map(); // url -> {retries: number, lastAttempt: timestamp}
    this.permanentlyFailedThumbnails = new Set(); // URLs that have exceeded max retries - NEVER retry
    this.maxRetries = 10; // Allow 10 retries before giving up - be more forgiving
    this.getSrcTimeout = 30000; // 30 second timeout - shorter to allow retries sooner
    this.loadingThumbnails = new Set(); // Track thumbnails currently loading
    this.thumbnailsLoaded = false; // Track if we've started loading thumbnails
    this.maxConcurrentLoads = 6; // Slightly more concurrent loads
    this.retryBackoff = 5000; // Wait 5 seconds before retrying a failed thumbnail

    // Media items
    this.mediaItems = [];
    this.thumbnailMeshes = [];
    this.loadedTextures = new Map();

    // State
    this.isVisible = false;
    this.isDragging = false;
    this.dragStartY = 0;
    this.scrollStartPosition = 0;
    this.hoveredItem = null;

    // VR HUD reference (set by plugin for relative positioning)
    this.vrHUD = null;

    // Raycaster for interaction
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(0, 0);

    // Create gallery structure
    this.galleryGroup = new THREE.Group();
    this.galleryGroup.name = 'vr-gallery';
    this.galleryGroup.visible = false;

    this.createGalleryFrame();
    this.createScrollIndicator();

    this.scene.add(this.galleryGroup);

    // Enable gallery to be visible on all camera layers (0, 1, 2)
    // This ensures it renders correctly for both eyes in stereoscopic mode
    this.galleryGroup.traverse((obj) => {
      if (obj.isMesh || obj.isGroup) {
        obj.layers.enableAll();
      }
    });

    // Bind methods
    this.update = this.update.bind(this);
    this.handleScroll = this.handleScroll.bind(this);

    // Setup interaction
    this.setupInteraction();
  }

  createGalleryFrame() {
    // Calculate frame dimensions
    const frameWidth = this.columns * (this.thumbnailWidth + this.thumbnailSpacing) + 0.3;
    const frameHeight = this.visibleRows * (this.thumbnailHeight + this.thumbnailSpacing) + 0.4;
    const cornerRadius = 0.08;

    // Background panel with dark glassmorphic styling (no blue tint)
    const frameShape = this.createRoundedRectShape(frameWidth, frameHeight, cornerRadius);
    const frameGeometry = new THREE.ShapeGeometry(frameShape);
    frameGeometry.translate(-frameWidth / 2, -frameHeight / 2, 0);
    const frameMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a, // Neutral dark gray, no blue tint
      opacity: 0.85,
      transparent: true,
      side: THREE.DoubleSide
    });

    this.galleryFrame = new THREE.Mesh(frameGeometry, frameMaterial);
    // Position galleryFrame at local origin - galleryGroup handles world positioning in update()
    this.galleryFrame.position.set(0, 0, 0);
    this.galleryGroup.add(this.galleryFrame);

    // Subtle white border (no cyan glow)
    const borderShape = this.createRoundedRectShape(frameWidth + 0.02, frameHeight + 0.02, cornerRadius + 0.01);
    const borderGeometry = new THREE.ShapeGeometry(borderShape);
    borderGeometry.translate(-(frameWidth + 0.02) / 2, -(frameHeight + 0.02) / 2, 0);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      opacity: 0.1,
      transparent: true,
      side: THREE.DoubleSide
    });
    const border = new THREE.Mesh(borderGeometry, borderMaterial);
    border.position.z = -0.001;
    this.galleryFrame.add(border);

    // Close button
    this.closeBtn = this.createCloseButton();
    this.closeBtn.position.set(frameWidth / 2 - 0.1, frameHeight / 2 - 0.1, 0.01);
    this.galleryFrame.add(this.closeBtn);

    // Thumbnail container (will be clipped)
    this.thumbnailContainer = new THREE.Group();
    this.thumbnailContainer.name = 'thumbnail-container';
    this.galleryFrame.add(this.thumbnailContainer);

    // Scroll area background (for drag detection)
    const scrollAreaGeometry = new THREE.PlaneGeometry(
      frameWidth - 0.5,
      frameHeight - 0.3
    );
    const scrollAreaMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      opacity: 0,
      transparent: true
    });
    this.scrollArea = new THREE.Mesh(scrollAreaGeometry, scrollAreaMaterial);
    this.scrollArea.position.z = 0.005;
    this.scrollArea.userData.interactive = true;
    this.scrollArea.userData.type = 'scroll-area';
    this.galleryFrame.add(this.scrollArea);

    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;

    // Set clipping bounds for thumbnail visibility (in local gallery frame coordinates)
    // Frame top is at +frameHeight/2, bottom at -frameHeight/2
    // Thumbnails have height 0.3, so we need margin > thumbnailHeight/2 to keep them inside border
    const topMargin = 0.15; // Small margin at top (no title now)
    const bottomMargin = 0.25; // Larger margin to keep thumbnails inside cyan border
    this.clipMaxY = frameHeight / 2 - topMargin; // Near top edge
    this.clipMinY = -frameHeight / 2 + bottomMargin; // Well above bottom edge

    // Create THREE.js clipping planes for proper overflow clipping
    // Top plane: clips anything above clipMaxY (normal points down, -Y direction)
    // Bottom plane: clips anything below clipMinY (normal points up, +Y direction)
    // Planes are in local coordinates relative to the thumbnailContainer
    this.topClipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), this.clipMaxY);
    this.bottomClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.clipMinY);
    this.clippingPlanes = [this.topClipPlane, this.bottomClipPlane];

    // Enable local clipping on the renderer
    if (this.renderer) {
      this.renderer.localClippingEnabled = true;
    }
  }

  createCloseButton() {
    const btnGroup = new THREE.Group();
    btnGroup.name = 'gallery-close-btn';

    const btnGeometry = new THREE.CircleGeometry(0.06, 32);
    const btnMaterial = new THREE.MeshBasicMaterial({
      color: 0x2a2a2a, // Neutral dark gray base
      opacity: 0.9,
      transparent: true
    });
    const btnMesh = new THREE.Mesh(btnGeometry, btnMaterial);
    btnMesh.userData.interactive = true;
    btnMesh.userData.type = 'gallery-close';
    btnMesh.userData.baseColor = 0x2a2a2a;
    btnMesh.userData.hoverColor = 0xff3366; // Red on hover
    btnGroup.add(btnMesh);

    // Subtle white border
    const borderGeometry = new THREE.RingGeometry(0.058, 0.062, 32);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      opacity: 0.15,
      transparent: true
    });
    const borderMesh = new THREE.Mesh(borderGeometry, borderMaterial);
    borderMesh.position.z = 0.0005;
    btnGroup.add(borderMesh);

    // X label
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✕', 16, 16);

    const labelTexture = new THREE.CanvasTexture(canvas);
    const labelMaterial = new THREE.MeshBasicMaterial({
      map: labelTexture,
      transparent: true
    });
    const labelGeometry = new THREE.PlaneGeometry(0.06, 0.06);
    const labelMesh = new THREE.Mesh(labelGeometry, labelMaterial);
    labelMesh.position.z = 0.001;
    btnGroup.add(labelMesh);

    return btnGroup;
  }

  // Helper to create vertical pill shape with true semicircular ends
  createVerticalPillShape(width, height) {
    const shape = new THREE.Shape();
    const radius = width / 2;
    // Start at bottom-left
    shape.moveTo(0, radius);
    // Left edge going up
    shape.lineTo(0, height - radius);
    // Top semicircle (clockwise from left to right)
    shape.absarc(radius, height - radius, radius, Math.PI, 0, true);
    // Right edge going down
    shape.lineTo(width, radius);
    // Bottom semicircle (clockwise from right to left)
    shape.absarc(radius, radius, radius, 0, Math.PI, true);
    return shape;
  }

  createScrollIndicator() {
    const indicatorGroup = new THREE.Group();
    indicatorGroup.name = 'scroll-indicator';

    // Track - dark neutral gray with true semicircular ends (vertical pill)
    const trackHeight = this.frameHeight - 0.4;
    const trackWidth = 0.03;
    const trackShape = this.createVerticalPillShape(trackWidth, trackHeight);
    const trackGeometry = new THREE.ShapeGeometry(trackShape);
    trackGeometry.translate(-trackWidth / 2, -trackHeight / 2, 0);
    const trackMaterial = new THREE.MeshBasicMaterial({
      color: 0x333333, // Neutral dark gray
      opacity: 0.8,
      transparent: true
    });
    const track = new THREE.Mesh(trackGeometry, trackMaterial);
    indicatorGroup.add(track);

    // Thumb - white scrollbar with true semicircular ends (vertical pill)
    const thumbWidth = 0.04;
    const thumbHeight = 0.15;
    const thumbShape = this.createVerticalPillShape(thumbWidth, thumbHeight);
    const thumbGeometry = new THREE.ShapeGeometry(thumbShape);
    thumbGeometry.translate(-thumbWidth / 2, -thumbHeight / 2, 0);
    const thumbMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff, // White thumb
      opacity: 0.7,
      transparent: true
    });
    this.scrollThumb = new THREE.Mesh(thumbGeometry, thumbMaterial);
    this.scrollThumb.position.z = 0.001;
    this.scrollThumb.position.y = trackHeight / 2 - 0.075;
    indicatorGroup.add(this.scrollThumb);

    indicatorGroup.position.set(this.frameWidth / 2 - 0.1, 0, 0.01);
    this.galleryFrame.add(indicatorGroup);

    this.scrollTrackHeight = trackHeight;
  }

  createThumbnail(item, index) {
    const thumbnailGroup = new THREE.Group();
    thumbnailGroup.name = `thumbnail-${index}`;
    thumbnailGroup.userData.mediaItem = item;

    // Calculate grid position
    const col = index % this.columns;
    const row = Math.floor(index / this.columns);

    const x = (col - (this.columns - 1) / 2) * (this.thumbnailWidth + this.thumbnailSpacing);
    const y = -row * (this.thumbnailHeight + this.thumbnailSpacing);

    thumbnailGroup.position.set(x, y + 0.4, 0.01);

    // Rounded corners using a custom shape
    const cornerRadius = 0.02;
    const thumbShape = this.createRoundedRectShape(this.thumbnailWidth, this.thumbnailHeight, cornerRadius);
    const thumbShapeGeometry = new THREE.ShapeGeometry(thumbShape);

    // Thumbnail background with dark glassmorphic styling (no blue tint)
    // Apply clipping planes to keep thumbnails within gallery bounds
    const bgMaterial = new THREE.MeshBasicMaterial({
      color: 0x2a2a2a, // Neutral dark gray
      opacity: 0.9,
      transparent: true,
      clippingPlanes: this.clippingPlanes,
      clipShadows: true
    });
    const bgMesh = new THREE.Mesh(thumbShapeGeometry.clone(), bgMaterial);
    bgMesh.position.set(-this.thumbnailWidth / 2, -this.thumbnailHeight / 2, 0);
    thumbnailGroup.add(bgMesh);

    // Subtle white border (no cyan glow)
    const borderShape = this.createRoundedRectShape(this.thumbnailWidth + 0.01, this.thumbnailHeight + 0.01, cornerRadius + 0.003);
    const borderGeometry = new THREE.ShapeGeometry(borderShape);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      opacity: 0.15,
      transparent: true,
      clippingPlanes: this.clippingPlanes,
      clipShadows: true
    });
    const borderMesh = new THREE.Mesh(borderGeometry, borderMaterial);
    borderMesh.position.set(-this.thumbnailWidth / 2 - 0.005, -this.thumbnailHeight / 2 - 0.005, -0.001);
    thumbnailGroup.add(borderMesh);

    // Image covers the entire card (use same shape as background)
    const imgGeometry = new THREE.ShapeGeometry(thumbShape);

    // Normalize UVs to 0-1 range - ShapeGeometry creates UVs based on shape coords
    // which are in world units (0-0.5 x 0-0.3), not normalized for texture mapping
    const uvAttr = imgGeometry.attributes.uv;
    if (uvAttr) {
      for (let i = 0; i < uvAttr.count; i++) {
        uvAttr.setX(i, uvAttr.getX(i) / this.thumbnailWidth);
        uvAttr.setY(i, uvAttr.getY(i) / this.thumbnailHeight);
      }
      uvAttr.needsUpdate = true;
    }

    // Create loading texture - neutral dark gray
    const loadingCanvas = document.createElement('canvas');
    loadingCanvas.width = 256;
    loadingCanvas.height = 144;
    const ctx = loadingCanvas.getContext('2d');
    ctx.fillStyle = '#333333'; // Neutral dark gray
    ctx.fillRect(0, 0, 256, 144);
    ctx.fillStyle = '#ffffff'; // White text
    ctx.font = '20px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading...', 128, 72);

    const loadingTexture = new THREE.CanvasTexture(loadingCanvas);
    const imgMaterial = new THREE.MeshBasicMaterial({
      map: loadingTexture,
      transparent: true,
      clippingPlanes: this.clippingPlanes,
      clipShadows: true
    });
    const imgMesh = new THREE.Mesh(imgGeometry, imgMaterial);
    // Position at same spot as background so image covers entire card
    imgMesh.position.set(-this.thumbnailWidth / 2, -this.thumbnailHeight / 2, 0.002);
    imgMesh.userData.interactive = true;
    imgMesh.userData.type = 'thumbnail';
    imgMesh.userData.index = index;
    imgMesh.userData.baseColor = null;
    thumbnailGroup.add(imgMesh);

    // Store thumbnail URL for lazy loading (only load when gallery is visible)
    if (item.thumbnail) {
      imgMesh.userData.thumbnailUrl = item.thumbnail;
    }

    // Store stereo mode for texture UV cropping (sbs = left half, tb = top half)
    if (item.stereoMode) {
      imgMesh.userData.stereoMode = item.stereoMode;
    }

    // Title label - overlaid at bottom edge with semi-transparent background
    // Rounded corners at bottom to match thumbnail card shape
    const titleCanvas = document.createElement('canvas');
    titleCanvas.width = 256;
    titleCanvas.height = 40;
    const titleCtx = titleCanvas.getContext('2d');
    // Semi-transparent dark background with rounded bottom corners
    const titleCornerRadius = 10; // Match thumbnail corner radius scaled to canvas
    titleCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    titleCtx.beginPath();
    titleCtx.moveTo(0, 0);
    titleCtx.lineTo(256, 0);
    titleCtx.lineTo(256, 40 - titleCornerRadius);
    titleCtx.quadraticCurveTo(256, 40, 256 - titleCornerRadius, 40);
    titleCtx.lineTo(titleCornerRadius, 40);
    titleCtx.quadraticCurveTo(0, 40, 0, 40 - titleCornerRadius);
    titleCtx.lineTo(0, 0);
    titleCtx.fill();
    titleCtx.fillStyle = '#ffffff';
    titleCtx.font = '16px Arial';
    titleCtx.textAlign = 'center';
    titleCtx.textBaseline = 'middle';

    const title = item.title || `Video ${index + 1}`;
    const truncatedTitle = title.length > 25 ? title.substring(0, 22) + '...' : title;
    titleCtx.fillText(truncatedTitle, 128, 20);

    const titleTexture = new THREE.CanvasTexture(titleCanvas);
    const titleMaterial = new THREE.MeshBasicMaterial({
      map: titleTexture,
      transparent: true,
      clippingPlanes: this.clippingPlanes,
      clipShadows: true
    });
    const titleGeometry = new THREE.PlaneGeometry(this.thumbnailWidth, 0.05);
    const titleMesh = new THREE.Mesh(titleGeometry, titleMaterial);
    // Position at very bottom of the card
    titleMesh.position.set(0, -this.thumbnailHeight / 2 + 0.025, 0.003);
    thumbnailGroup.add(titleMesh);

    // Duration badge (if provided)
    if (item.duration) {
      const durationBadge = this.createDurationBadge(item.duration);
      durationBadge.position.set(
        this.thumbnailWidth / 2 - 0.06,
        -this.thumbnailHeight / 2 + 0.1,
        0.003
      );
      thumbnailGroup.add(durationBadge);
    }

    this.thumbnailContainer.add(thumbnailGroup);
    this.thumbnailMeshes.push(imgMesh);

    // Enable all layers for this thumbnail so it renders to both eyes
    thumbnailGroup.traverse((obj) => {
      if (obj.isMesh || obj.isGroup) {
        obj.layers.enableAll();
      }
    });

    return thumbnailGroup;
  }

  createDurationBadge(duration) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.roundRect(0, 0, 64, 24, 4);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.formatDuration(duration), 32, 12);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      clippingPlanes: this.clippingPlanes,
      clipShadows: true
    });
    const geometry = new THREE.PlaneGeometry(0.1, 0.04);
    return new THREE.Mesh(geometry, material);
  }

  formatDuration(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00';

    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  async loadThumbnailTexture(url, mesh) {
    // Check cache first
    if (this.loadedTextures.has(url)) {
      mesh.material.map = this.loadedTextures.get(url);
      mesh.material.needsUpdate = true;
      return;
    }

    // Check permanent blacklist - NEVER retry these
    if (this.permanentlyFailedThumbnails.has(url)) {
      return;
    }

    // Check if already loading this thumbnail
    if (this.loadingThumbnails.has(url)) {
      return;
    }

    // Check if we've already tried this thumbnail
    const failInfo = this.failedLoads.get(url);
    if (failInfo) {
      if (failInfo.retries >= this.maxRetries) {
        // Add to permanent blacklist and never try again
        this.permanentlyFailedThumbnails.add(url);
        this.loadingThumbnails.delete(url);
        return;
      }
      // Check if we need to wait before retrying (respect backoff)
      const timeSinceLastAttempt = Date.now() - failInfo.lastAttempt;
      if (timeSinceLastAttempt < this.retryBackoff) {
        // Not enough time has passed, skip for now
        return;
      }
    }

    // Mark as loading
    this.loadingThumbnails.add(url);

    // Helper to load texture from resolved URL
    const loadTextureFromUrl = (resolvedUrl) => {
      const loader = new THREE.TextureLoader();
      loader.crossOrigin = 'anonymous';

      loader.load(
        resolvedUrl,
        (texture) => {
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.wrapS = THREE.ClampToEdgeWrapping;
          texture.wrapT = THREE.ClampToEdgeWrapping;

          // Get texture dimensions for aspect-fill calculation
          const imgWidth = texture.image.width;
          const imgHeight = texture.image.height;

          // Apply stereo cropping first, then aspect-fill
          const stereoMode = mesh.userData.stereoMode;
          let effectiveWidth = imgWidth;
          let effectiveHeight = imgHeight;
          let stereoOffsetX = 0;
          let stereoOffsetY = 0;
          let stereoScaleX = 1;
          let stereoScaleY = 1;

          if (stereoMode === 'sbs') {
            // Left half only
            effectiveWidth = imgWidth / 2;
            stereoScaleX = 0.5;
          } else if (stereoMode === 'tb') {
            // Top half only
            effectiveHeight = imgHeight / 2;
            stereoScaleY = 0.5;
            stereoOffsetY = 0.5; // Offset to top half
          }

          // Calculate aspect ratios
          const textureAspect = effectiveWidth / effectiveHeight;
          const cardAspect = this.thumbnailWidth / this.thumbnailHeight;

          // Aspect-fill: scale texture to cover the entire card, cropping excess
          let repeatX = stereoScaleX;
          let repeatY = stereoScaleY;
          let offsetX = stereoOffsetX;
          let offsetY = stereoOffsetY;

          if (textureAspect > cardAspect) {
            // Texture is wider - need to crop horizontally
            const scale = cardAspect / textureAspect;
            repeatX = stereoScaleX * scale;
            offsetX = stereoOffsetX + (stereoScaleX - repeatX) / 2; // Center horizontally
          } else {
            // Texture is taller - need to crop vertically
            const scale = textureAspect / cardAspect;
            repeatY = stereoScaleY * scale;
            offsetY = stereoOffsetY + (stereoScaleY - repeatY) / 2; // Center vertically
          }

          texture.repeat.set(repeatX, repeatY);
          texture.offset.set(offsetX, offsetY);
          texture.needsUpdate = true;

          this.loadedTextures.set(url, texture);

          // Clear failed count on success
          this.failedLoads.delete(url);
          this.loadingThumbnails.delete(url);

          mesh.material.map = texture;
          mesh.material.needsUpdate = true;
        },
        undefined,
        () => {
          const failedInfo = this.failedLoads.get(url);
          const currentRetries = (failedInfo ? failedInfo.retries : 0) + 1;
          if (currentRetries === 1) {
            console.warn('[VR Gallery] Failed to load thumbnail:', url);
          }
          this.failedLoads.set(url, {
            retries: currentRetries,
            lastAttempt: Date.now()
          });
          if (currentRetries >= this.maxRetries) {
            this.permanentlyFailedThumbnails.add(url);
          }
          this.loadingThumbnails.delete(url);
        }
      );
    };

    try {
      const getSrcFunc = this.getSrc;

      if (getSrcFunc && typeof getSrcFunc === 'function') {
        // Start getSrc WITHOUT a hard timeout that abandons the request
        // Let it complete in the background and apply texture when done
        getSrcFunc(url, 'vr-gallery')
          .then((resolvedUrl) => {
            // Check if already loaded (by another path) or permanently failed
            if (this.loadedTextures.has(url) || this.permanentlyFailedThumbnails.has(url)) {
              this.loadingThumbnails.delete(url);
              return;
            }
            loadTextureFromUrl(resolvedUrl);
          })
          .catch((error) => {
            const failedData = this.failedLoads.get(url);
            const currentRetries = (failedData ? failedData.retries : 0) + 1;
            if (currentRetries === 1) {
              console.warn('[VR Gallery] getSrc failed for:', url, error.message);
            }
            this.failedLoads.set(url, {
              retries: currentRetries,
              lastAttempt: Date.now()
            });
            if (currentRetries >= this.maxRetries) {
              this.permanentlyFailedThumbnails.add(url);
            }
            this.loadingThumbnails.delete(url);
          });
      } else {
        // No getSrc function - load directly
        loadTextureFromUrl(url);
      }
    } catch (error) {
      const currentRetries = (failInfo ? failInfo.retries : 0) + 1;
      if (currentRetries === 1) {
        console.warn('[VR Gallery] Failed to resolve thumbnail path:', url);
      }
      this.failedLoads.set(url, {
        retries: currentRetries,
        lastAttempt: Date.now()
      });
      if (currentRetries >= this.maxRetries) {
        this.permanentlyFailedThumbnails.add(url);
      }
      this.loadingThumbnails.delete(url);
    }
  }

  setMediaItems(items) {
    // Clear existing thumbnails
    this.clearThumbnails();

    this.mediaItems = items;
    this.scrollPosition = 0;
    this.thumbnailsLoaded = false; // Reset to trigger loading when gallery is shown

    // Calculate max scroll
    const totalRows = Math.ceil(items.length / this.columns);
    const contentHeight = totalRows * (this.thumbnailHeight + this.thumbnailSpacing);
    const viewHeight = this.visibleRows * (this.thumbnailHeight + this.thumbnailSpacing);
    this.maxScroll = Math.max(0, contentHeight - viewHeight);

    // Create thumbnails
    items.forEach((item, index) => {
      this.createThumbnail(item, index);
    });

    this.updateScrollPosition();
  }

  clearThumbnails() {
    // Remove all thumbnail groups
    while (this.thumbnailContainer.children.length > 0) {
      const child = this.thumbnailContainer.children[0];
      this.thumbnailContainer.remove(child);

      // Dispose geometries and materials
      child.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (obj.material.map && !this.loadedTextures.has(obj.material.map)) {
            obj.material.map.dispose();
          }
          obj.material.dispose();
        }
      });
    }

    this.thumbnailMeshes = [];
  }

  setupInteraction() {
    // Mouse wheel for scrolling
    if (this.renderer.domElement) {
      this.renderer.domElement.addEventListener('wheel', (e) => {
        if (this.isVisible) {
          this.handleScroll(e.deltaY * 0.002);
        }
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

      this.renderer.domElement.addEventListener('click', (e) => {
        this.handleClick(e);
      });
    }

    // VR controller support
    if (this.renderer.xr) {
      const controller0 = this.renderer.xr.getController(0);
      const controller1 = this.renderer.xr.getController(1);

      [controller0, controller1].forEach((controller) => {
        if (controller) {
          controller.addEventListener('select', this.handleVRSelect.bind(this));
          controller.addEventListener('squeeze', () => this.handleScroll(-0.1));
        }
      });
    }
  }

  handleMouseDown(event) {
    if (!this.isVisible) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObject(this.scrollArea);

    if (intersects.length > 0) {
      this.isDragging = true;
      this.dragStartY = event.clientY;
      this.scrollStartPosition = this.scrollPosition;
    }
  }

  handleMouseUp(event) {
    this.isDragging = false;
  }

  handleMouseMove(event) {
    if (!this.isVisible) return;

    if (this.isDragging) {
      const deltaY = (event.clientY - this.dragStartY) * 0.005;
      this.scrollPosition = Math.max(0, Math.min(this.maxScroll,
        this.scrollStartPosition + deltaY));
      this.updateScrollPosition();
    }

    // Hover effect
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.thumbnailMeshes);

    // Reset previous hover
    if (this.hoveredItem) {
      this.hoveredItem.parent.scale.set(1, 1, 1);
    }

    if (intersects.length > 0) {
      this.hoveredItem = intersects[0].object;
      this.hoveredItem.parent.scale.set(1.05, 1.05, 1.05);
    } else {
      this.hoveredItem = null;
    }
  }

  handleClick(event) {
    if (!this.isVisible) return;
    if (this.selectionCooldown) return; // Don't select during cooldown after opening

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Check close button
    const closeIntersects = this.raycaster.intersectObjects(
      this.closeBtn.children.filter(c => c.userData.interactive)
    );
    if (closeIntersects.length > 0) {
      this.hide();
      return;
    }

    // Check thumbnails
    const intersects = this.raycaster.intersectObjects(this.thumbnailMeshes);
    if (intersects.length > 0) {
      const index = intersects[0].object.userData.index;
      const mediaItem = this.mediaItems[index];
      if (mediaItem) {
        this.onMediaSelect(mediaItem, index);
        this.hide();
      }
    }
  }

  handleVRSelect(event) {
    if (!this.isVisible) return;
    if (this.selectionCooldown) return; // Don't select during cooldown after opening

    const controller = event.target;
    const tempMatrix = new THREE.Matrix4();
    tempMatrix.identity().extractRotation(controller.matrixWorld);

    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

    // Check close button
    const closeIntersects = this.raycaster.intersectObjects(
      this.closeBtn.children.filter(c => c.userData.interactive)
    );
    if (closeIntersects.length > 0) {
      this.hide();
      return;
    }

    // Check thumbnails
    const intersects = this.raycaster.intersectObjects(this.thumbnailMeshes);
    if (intersects.length > 0) {
      const index = intersects[0].object.userData.index;
      const mediaItem = this.mediaItems[index];
      if (mediaItem) {
        this.onMediaSelect(mediaItem, index);
        this.hide();
      }
    }
  }

  handleScroll(delta) {
    this.scrollPosition = Math.max(0, Math.min(this.maxScroll,
      this.scrollPosition + delta));
    this.updateScrollPosition();

    // Debounce retry of visible thumbnails after scrolling stops
    if (this.scrollDebounceTimer) {
      clearTimeout(this.scrollDebounceTimer);
    }
    this.scrollDebounceTimer = setTimeout(() => {
      // Clear recent failures to allow retrying visible thumbnails
      const now = Date.now();
      for (const [url, info] of this.failedLoads.entries()) {
        // Clear failures that are older than 2 seconds so visible thumbnails get another chance
        if (info.retries < this.maxRetries && now - info.lastAttempt > 2000) {
          this.failedLoads.delete(url);
        }
      }
      // Trigger loading of visible thumbnails
      this.loadVisibleThumbnails();
    }, 300); // 300ms after scroll stops
  }

  // Public method for external scrolling (e.g., from joystick)
  scroll(amount) {
    this.handleScroll(amount);
  }

  updateScrollPosition() {
    // Move thumbnail container
    this.thumbnailContainer.position.y = this.scrollPosition;

    // Update scroll thumb position
    if (this.maxScroll > 0) {
      const thumbTravel = this.scrollTrackHeight - 0.15;
      const scrollRatio = this.scrollPosition / this.maxScroll;
      this.scrollThumb.position.y = (this.scrollTrackHeight / 2 - 0.075) -
        (scrollRatio * thumbTravel);
    }
  }

  show() {
    this.isVisible = true;
    this.galleryGroup.visible = true;

    // Enable local clipping on the renderer for thumbnail overflow
    if (this.renderer) {
      this.renderer.localClippingEnabled = true;
    }

    // Prevent immediate selection when gallery opens (cooldown period)
    this.selectionCooldown = true;
    setTimeout(() => {
      this.selectionCooldown = false;
    }, 300);

    // Load thumbnails when gallery is shown (deduplication in viewer prevents infinite loops)
    if (!this.thumbnailsLoaded) {
      this.thumbnailsLoaded = true;
      this.loadAllThumbnails();
    }
  }

  loadAllThumbnails() {
    // Only load visible thumbnails initially - lazy load others as user scrolls
    this.loadVisibleThumbnails();
  }

  loadVisibleThumbnails() {
    // Load thumbnails that are currently visible (within clipping region)
    // Clear old failed thumbnails that can be retried (after retryBackoff period)
    const now = Date.now();
    for (const [url, info] of this.failedLoads.entries()) {
      if (info.retries < this.maxRetries && now - info.lastAttempt > this.retryBackoff) {
        this.failedLoads.delete(url);
      }
    }

    const currentlyLoading = this.loadingThumbnails.size;
    const buffer = 4; // Load 4 extra rows above/below for smoother scrolling
    const halfHeight = this.thumbnailHeight / 2;
    const rowHeight = this.thumbnailHeight + this.thumbnailSpacing;
    const bufferSize = rowHeight * buffer;

    // First pass: Find ALL visible thumbnails that need loading
    // This ensures we know what to load even if we're at capacity
    const visibleToLoad = [];
    for (let i = 0; i < this.thumbnailMeshes.length; i++) {
      const mesh = this.thumbnailMeshes[i];
      if (!mesh) continue;

      const thumbnailUrl = mesh.userData.thumbnailUrl;
      if (!thumbnailUrl || this.loadedTextures.has(thumbnailUrl)) continue;
      if (this.loadingThumbnails.has(thumbnailUrl)) continue;
      if (this.permanentlyFailedThumbnails.has(thumbnailUrl)) continue;

      // Get the parent thumbnailGroup's position (mesh is imgMesh inside thumbnailGroup)
      const thumbnailGroup = mesh.parent;
      if (!thumbnailGroup) continue;

      // Check if thumbnail is in or near visible region
      // thumbnailGroup.position.y is relative to thumbnailContainer
      const thumbnailY = thumbnailGroup.position.y + this.scrollPosition;
      const thumbnailTop = thumbnailY + halfHeight;
      const thumbnailBottom = thumbnailY - halfHeight;

      // Include buffer zone for preloading
      const isVisible = thumbnailBottom <= (this.clipMaxY + bufferSize) &&
                        thumbnailTop >= (this.clipMinY - bufferSize);

      if (isVisible) {
        // Calculate distance from center of visible area for priority
        const centerY = (this.clipMaxY + this.clipMinY) / 2;
        const distFromCenter = Math.abs(thumbnailY - centerY);
        visibleToLoad.push({ mesh, url: thumbnailUrl, distance: distFromCenter });
      }
    }

    // Sort by distance from center (load center thumbnails first)
    visibleToLoad.sort((a, b) => a.distance - b.distance);

    // Second pass: Load up to maxConcurrentLoads
    const maxToLoad = this.maxConcurrentLoads - currentlyLoading;
    let loadedCount = 0;
    for (const item of visibleToLoad) {
      if (loadedCount >= maxToLoad) break;
      this.loadThumbnailTexture(item.url, item.mesh);
      loadedCount++;
    }

    if (loadedCount > 0) {
      console.log(`[VR Gallery] Loading ${loadedCount} visible thumbnails (${currentlyLoading} in progress, ${visibleToLoad.length - loadedCount} queued)`);
    }
  }

  hide() {
    this.isVisible = false;
    this.galleryGroup.visible = false;
  }

  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  // Refresh all layer masks to ensure proper stereo rendering
  refreshLayers() {
    this.galleryGroup.traverse((obj) => {
      if (obj.isMesh || obj.isGroup) {
        obj.layers.enableAll();
      }
    });
  }

  update() {
    if (!this.isVisible) return;

    // Periodically refresh layers as a safety net against double vision
    this.layerRefreshCounter = (this.layerRefreshCounter || 0) + 1;
    if (this.layerRefreshCounter >= 120) { // Every ~2 seconds at 60fps
      this.layerRefreshCounter = 0;
      this.refreshLayers();
    }

    // Position gallery relative to VR HUD if available (stays fixed in scene)
    if (this.vrHUD && this.vrHUD.hudGroup) {
      // Position gallery above the HUD controls
      const hudPos = this.vrHUD.hudGroup.position.clone();
      const hudQuat = this.vrHUD.hudGroup.quaternion.clone();

      // Calculate proper offset so gallery bottom is above HUD top
      // HUD panel height = 0.6, so HUD top is at hudPos.y + 0.3
      // Gallery frameHeight = ~1.54, so we need gallery center at hudPos.y + 0.3 + 0.1 (gap) + frameHeight/2
      // This equals hudPos.y + 0.3 + 0.1 + 0.77 = hudPos.y + 1.17
      this.galleryGroup.position.copy(hudPos);
      this.galleryGroup.position.y += 1.2;  // Position so bottom is just above HUD top

      // Match HUD orientation
      this.galleryGroup.quaternion.copy(hudQuat);
    } else {
      // Fallback: position in scene at reduced distance
      this.galleryGroup.position.set(0, 0.8, -this.galleryDistance);
      this.galleryGroup.rotation.set(0, 0, 0);
    }

    // Update clipping planes to match gallery world transform
    // The planes need to be in world space for proper clipping
    if (this.topClipPlane && this.bottomClipPlane && this.galleryFrame) {
      // Get the gallery frame's world matrix
      this.galleryFrame.updateWorldMatrix(true, false);
      const worldMatrix = this.galleryFrame.matrixWorld;

      // Get world position and orientation
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      worldMatrix.decompose(worldPos, worldQuat, new THREE.Vector3());

      // Transform the local clipping planes to world space
      // Top plane clips above clipMaxY in local Y
      const topNormal = new THREE.Vector3(0, -1, 0).applyQuaternion(worldQuat);
      const topPoint = new THREE.Vector3(0, this.clipMaxY, 0).applyMatrix4(worldMatrix);
      this.topClipPlane.setFromNormalAndCoplanarPoint(topNormal, topPoint);

      // Bottom plane clips below clipMinY in local Y
      const bottomNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat);
      const bottomPoint = new THREE.Vector3(0, this.clipMinY, 0).applyMatrix4(worldMatrix);
      this.bottomClipPlane.setFromNormalAndCoplanarPoint(bottomNormal, bottomPoint);
    }

    // Also use visibility toggle for performance (don't render completely hidden thumbnails)
    const halfHeight = this.thumbnailHeight / 2;
    this.thumbnailMeshes.forEach((thumbnail, index) => {
      if (thumbnail && thumbnail.parent) {
        const thumbnailGroup = thumbnail.parent;
        const thumbnailY = thumbnailGroup.position.y + this.scrollPosition;
        const thumbnailTop = thumbnailY + halfHeight;
        const thumbnailBottom = thumbnailY - halfHeight;
        // Hide only when completely outside the visible region (with some buffer for partial clipping)
        const visible = thumbnailBottom <= (this.clipMaxY + halfHeight) && thumbnailTop >= (this.clipMinY - halfHeight);
        thumbnailGroup.visible = visible;
      }
    });

    // Lazy load visible thumbnails (throttled)
    const now = Date.now();
    if (!this.lastThumbnailLoad || now - this.lastThumbnailLoad > 200) {
      this.lastThumbnailLoad = now;
      this.loadVisibleThumbnails();
    }
  }

  // Helper to create rounded rectangle shapes for glassmorphic thumbnails
  createRoundedRectShape(width, height, radius) {
    const shape = new THREE.Shape();
    const x = 0;
    const y = 0;

    shape.moveTo(x + radius, y);
    shape.lineTo(x + width - radius, y);
    shape.quadraticCurveTo(x + width, y, x + width, y + radius);
    shape.lineTo(x + width, y + height - radius);
    shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    shape.lineTo(x + radius, y + height);
    shape.quadraticCurveTo(x, y + height, x, y + height - radius);
    shape.lineTo(x, y + radius);
    shape.quadraticCurveTo(x, y, x + radius, y);

    return shape;
  }

  dispose() {
    this.clearThumbnails();
    this.scene.remove(this.galleryGroup);

    // Dispose cached textures
    this.loadedTextures.forEach((texture) => {
      texture.dispose();
    });
    this.loadedTextures.clear();

    // Dispose gallery frame
    this.galleryGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
  }
}

export default VRGallery;

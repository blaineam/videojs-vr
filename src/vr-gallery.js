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
    this.galleryDistance = 3.5;
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

    // Background panel
    const frameGeometry = new THREE.PlaneGeometry(frameWidth, frameHeight);
    const frameMaterial = new THREE.MeshBasicMaterial({
      color: 0x0a0a1a,
      opacity: 0.95,
      transparent: true,
      side: THREE.DoubleSide
    });

    this.galleryFrame = new THREE.Mesh(frameGeometry, frameMaterial);
    // Position gallery bottom edge just above HUD controls (HUD at y=3.5, height=0.6, so top ~3.8)
    // Gallery bottom should be at ~4.0, so y = 4.0 + frameHeight/2 = 4.0 + frameHeight/2
    this.galleryFrame.position.set(0, 4.0 + frameHeight / 2, -this.galleryDistance);
    this.galleryGroup.add(this.galleryFrame);

    // Frame border with glow effect
    const borderGeometry = new THREE.PlaneGeometry(frameWidth + 0.04, frameHeight + 0.04);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      opacity: 0.4,
      transparent: true,
      side: THREE.DoubleSide
    });
    const border = new THREE.Mesh(borderGeometry, borderMaterial);
    border.position.z = -0.002;
    this.galleryFrame.add(border);

    // Title
    const titleCanvas = document.createElement('canvas');
    titleCanvas.width = 512;
    titleCanvas.height = 64;
    const ctx = titleCanvas.getContext('2d');
    ctx.fillStyle = '#00ffff';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VR GALLERY', 256, 32);

    const titleTexture = new THREE.CanvasTexture(titleCanvas);
    const titleMaterial = new THREE.MeshBasicMaterial({
      map: titleTexture,
      transparent: true
    });
    const titleGeometry = new THREE.PlaneGeometry(0.8, 0.1);
    const titleMesh = new THREE.Mesh(titleGeometry, titleMaterial);
    titleMesh.position.set(0, frameHeight / 2 - 0.12, 0.01);
    this.galleryFrame.add(titleMesh);

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
    // Thumbnails will be culled if they're outside this vertical range
    const viewHeight = this.visibleRows * (this.thumbnailHeight + this.thumbnailSpacing);
    this.clipMinY = -viewHeight / 2 - 0.1; // Add small margin
    this.clipMaxY = viewHeight / 2 + 0.1;
  }

  createCloseButton() {
    const btnGroup = new THREE.Group();
    btnGroup.name = 'gallery-close-btn';

    const btnGeometry = new THREE.CircleGeometry(0.06, 16);
    const btnMaterial = new THREE.MeshBasicMaterial({
      color: 0xff3366,
      opacity: 0.9,
      transparent: true
    });
    const btnMesh = new THREE.Mesh(btnGeometry, btnMaterial);
    btnMesh.userData.interactive = true;
    btnMesh.userData.type = 'gallery-close';
    btnMesh.userData.baseColor = 0xff3366;
    btnMesh.userData.hoverColor = 0xff6699;
    btnGroup.add(btnMesh);

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

  createScrollIndicator() {
    const indicatorGroup = new THREE.Group();
    indicatorGroup.name = 'scroll-indicator';

    // Track
    const trackHeight = this.frameHeight - 0.4;
    const trackGeometry = new THREE.PlaneGeometry(0.03, trackHeight);
    const trackMaterial = new THREE.MeshBasicMaterial({
      color: 0x333355,
      opacity: 0.8,
      transparent: true
    });
    const track = new THREE.Mesh(trackGeometry, trackMaterial);
    indicatorGroup.add(track);

    // Thumb
    const thumbGeometry = new THREE.PlaneGeometry(0.04, 0.15);
    const thumbMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      opacity: 0.9,
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

    // Thumbnail background
    const bgGeometry = new THREE.PlaneGeometry(this.thumbnailWidth, this.thumbnailHeight);
    const bgMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1a3a,
      opacity: 0.9,
      transparent: true
    });
    const bgMesh = new THREE.Mesh(bgGeometry, bgMaterial);
    thumbnailGroup.add(bgMesh);

    // Thumbnail border
    const borderGeometry = new THREE.PlaneGeometry(
      this.thumbnailWidth + 0.01,
      this.thumbnailHeight + 0.01
    );
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: 0x3a3a5a,
      opacity: 0.8,
      transparent: true
    });
    const borderMesh = new THREE.Mesh(borderGeometry, borderMaterial);
    borderMesh.position.z = -0.001;
    thumbnailGroup.add(borderMesh);

    // Image placeholder (will be replaced with actual thumbnail)
    const imgGeometry = new THREE.PlaneGeometry(
      this.thumbnailWidth - 0.02,
      this.thumbnailHeight - 0.04
    );

    // Create loading texture
    const loadingCanvas = document.createElement('canvas');
    loadingCanvas.width = 256;
    loadingCanvas.height = 144;
    const ctx = loadingCanvas.getContext('2d');
    ctx.fillStyle = '#2a2a4a';
    ctx.fillRect(0, 0, 256, 144);
    ctx.fillStyle = '#00ffff';
    ctx.font = '20px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading...', 128, 72);

    const loadingTexture = new THREE.CanvasTexture(loadingCanvas);
    const imgMaterial = new THREE.MeshBasicMaterial({
      map: loadingTexture,
      transparent: true
    });
    const imgMesh = new THREE.Mesh(imgGeometry, imgMaterial);
    imgMesh.position.set(0, 0.02, 0.002);
    imgMesh.userData.interactive = true;
    imgMesh.userData.type = 'thumbnail';
    imgMesh.userData.index = index;
    imgMesh.userData.baseColor = null;
    thumbnailGroup.add(imgMesh);

    // Load actual thumbnail if URL provided
    if (item.thumbnail) {
      this.loadThumbnailTexture(item.thumbnail, imgMesh);
    }

    // Title label
    const titleCanvas = document.createElement('canvas');
    titleCanvas.width = 256;
    titleCanvas.height = 32;
    const titleCtx = titleCanvas.getContext('2d');
    titleCtx.fillStyle = '#ffffff';
    titleCtx.font = '14px Arial';
    titleCtx.textAlign = 'center';
    titleCtx.textBaseline = 'middle';

    const title = item.title || `Video ${index + 1}`;
    const truncatedTitle = title.length > 25 ? title.substring(0, 22) + '...' : title;
    titleCtx.fillText(truncatedTitle, 128, 16);

    const titleTexture = new THREE.CanvasTexture(titleCanvas);
    const titleMaterial = new THREE.MeshBasicMaterial({
      map: titleTexture,
      transparent: true
    });
    const titleGeometry = new THREE.PlaneGeometry(this.thumbnailWidth - 0.02, 0.04);
    const titleMesh = new THREE.Mesh(titleGeometry, titleMaterial);
    titleMesh.position.set(0, -this.thumbnailHeight / 2 + 0.03, 0.002);
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
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.formatDuration(duration), 32, 12);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true
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

    try {
      // Use getSrc to resolve the path to a blob URL if available
      let resolvedUrl = url;
      if (this.getSrc && typeof this.getSrc === 'function') {
        console.log('[VR Gallery] Resolving thumbnail path:', url);
        resolvedUrl = await this.getSrc(url, 'high');
        console.log('[VR Gallery] Resolved to:', resolvedUrl);
      } else {
        console.warn('[VR Gallery] getSrc not available, using raw URL:', url);
      }

      const loader = new THREE.TextureLoader();
      loader.crossOrigin = 'anonymous';

      loader.load(
        resolvedUrl,
        (texture) => {
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;

          this.loadedTextures.set(url, texture);

          mesh.material.map = texture;
          mesh.material.needsUpdate = true;
        },
        undefined,
        (error) => {
          console.warn('Failed to load thumbnail:', url, '(resolved:', resolvedUrl, ')', error);
        }
      );
    } catch (error) {
      console.warn('Failed to resolve thumbnail path:', url, error);
    }
  }

  setMediaItems(items) {
    // Clear existing thumbnails
    this.clearThumbnails();

    this.mediaItems = items;
    this.scrollPosition = 0;

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

  update() {
    if (!this.isVisible) return;

    // Make gallery face the camera
    this.galleryGroup.quaternion.copy(this.camera.quaternion);

    // Clip thumbnails outside visible area
    this.thumbnailMeshes.forEach((thumbnail, index) => {
      if (thumbnail) {
        const thumbnailY = thumbnail.position.y + this.scrollPosition;
        const visible = thumbnailY >= this.clipMinY && thumbnailY <= this.clipMaxY;
        thumbnail.visible = visible;
      }
    });
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

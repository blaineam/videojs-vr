# videojs-vr

A video.js plugin that turns a video element into a HTML5 Panoramic 360 video player. Project video onto different shapes with full WebXR support for immersive VR viewing on devices like Meta Quest, HTC Vive, and other WebXR-compatible headsets.

**Maintainer:** Blaine Miller

**PRs Welcome!** Contributions, bug reports, and feature requests are encouraged.

## Installation

```sh
npm install @blaineam/videojs-vr
```

## Features

- **Full WebXR Support**: Modern WebXR API support for immersive VR experiences on Quest, Vive, and other headsets
- **Multiple Projections**: Support for 360, 180, side-by-side (SBS), and equi-angular cubemap (EAC) video formats
- **Glassmorphic VR UI**: Beautiful frosted-glass design with translucent panels and subtle gradients for an immersive, non-intrusive interface
- **VR HUD Controls**: In-VR user interface with scrub bar, play/pause, and navigation controls
- **VR Gallery Panel**: Browse and select media while in VR mode with scrollable thumbnails and pill-shaped duration badges
- **Controller Support**: Full VR controller interaction with pointer rays and grip toggle
- **Orientation Controls**: Adjust viewing angle for comfortable viewing in any position
- **Stereo 3D Support**: Proper left/right eye rendering for stereoscopic content

## Browser Support

The most recent versions of:

### Desktop
- Chrome
- Firefox
- Safari

### Mobile
- Chrome on Android
- Safari on iOS

### VR Headsets (WebXR)
- Meta Quest (Quest 2, Quest 3, Quest Pro)
- HTC Vive / Vive Pro
- Valve Index
- Windows Mixed Reality headsets
- Any WebXR-compatible device

## Quick Start

### Script Tag

```html
<script src="//path/to/video.min.js"></script>
<script src="//path/to/videojs-vr.min.js"></script>
<script>
  var player = videojs('my-video');

  player.vr({
    projection: '360',
    enableVRHUD: true,
    enableVRGallery: true
  });
</script>
```

### ES Modules / Bundlers

```js
import videojs from 'video.js';
import '@blaineam/videojs-vr';

const player = videojs('my-video');

player.vr({
  projection: '360',
  enableVRHUD: true,
  enableVRGallery: true,
  onNext: () => console.log('Next video'),
  onPrevious: () => console.log('Previous video'),
  onFavorite: () => console.log('Toggle favorite')
});
```

## Projection Types

### Standard Projections

| Projection | Description |
|------------|-------------|
| `'360'` / `'Sphere'` / `'equirectangular'` | Full 360-degree spherical video |
| `'180'` | 180-degree half sphere video |
| `'180_MONO'` | Monoscopic 180-degree video |
| `'Cube'` / `'360_CUBE'` | 360-degree cube map video |
| `'NONE'` | Standard flat video (no VR projection) |
| `'AUTO'` | Automatically detect from `player.mediainfo.projection` |

### Side-by-Side (Stereoscopic) Projections

Side-by-side video contains separate left and right eye views packed into a single video frame. The plugin automatically separates these for proper stereoscopic viewing in VR headsets.

| Projection | Description |
|------------|-------------|
| `'360_LR'` | 360-degree with left/right eye side-by-side |
| `'360_TB'` | 360-degree with top/bottom eye layout |
| `'180_LR'` | 180-degree with left/right eye side-by-side |
| `'SBS_MONO'` | Flat screen side-by-side - shows stereo 3D in WebXR, mono in browser |

### Equi-Angular Cubemap (EAC)

| Projection | Description |
|------------|-------------|
| `'EAC'` | YouTube's equi-angular cubemap format |
| `'EAC_LR'` | EAC with left/right eye side-by-side |

## WebXR VR Mode

When viewing in a WebXR-compatible browser (like Meta Quest Browser), the plugin provides an immersive VR experience:

1. Click the **Cardboard/VR button** in the player controls to enter VR mode
2. **Squeeze the grip** on your VR controller to show/hide the VR HUD
3. Use the **thumbstick** to:
   - Left/Right: Seek through the video
   - Up/Down: Scroll through the gallery (when open)
4. **Point and click** with your controller to interact with buttons
5. Press **A button** on controller to toggle play/pause

### VR HUD Controls

The VR HUD provides these controls while in VR mode:

| Button | Function |
|--------|----------|
| **Exit (X)** | Exit VR mode |
| **Gallery** | Open the media gallery panel |
| **Previous** | Go to previous media item |
| **Play/Pause** | Toggle video playback |
| **Next** | Go to next media item |
| **Reset Orientation** | Reset view to default orientation |
| **Drag Handle** | Drag to adjust viewing angle (for lying down, etc.) |
| **Projection** | Open projection mode selector |
| **Favorite** | Toggle favorite status (if callback provided) |

The HUD also includes a **scrub bar** showing current playback position with a draggable handle for seeking.

## VR Gallery Panel

The VR Gallery allows users to browse and select media while remaining in VR:

```js
player.vr({
  projection: '360',
  enableVRGallery: true,
  mediaItems: [
    {
      title: 'Beach Sunset',
      thumbnail: '/thumbnails/beach.jpg',
      url: '/videos/beach-360.mp4',
      duration: 180 // seconds (optional)
    },
    {
      title: 'Mountain View',
      thumbnail: '/thumbnails/mountain.jpg',
      url: '/videos/mountain-360.mp4',
      duration: 240
    }
  ],
  onMediaSelect: (item, index) => {
    // Handle media selection
    player.src({ src: item.url, type: 'video/mp4' });
  }
});
```

### Gallery Features

- **Scrollable Grid**: 4-column thumbnail grid with smooth scrolling
- **Lazy Loading**: Thumbnails load as they become visible
- **VR Controller Support**: Point and click to select, use thumbstick to scroll
- **Mouse/Touch Support**: Works in non-VR mode too
- **Duration Badges**: Shows video duration on thumbnails

### Dynamic Gallery Updates

```js
// Update gallery items at runtime
player.vr().setGalleryItems([
  { title: 'New Video', thumbnail: '/thumb.jpg', url: '/video.mp4' }
]);

// Show/hide gallery programmatically
player.vr().showGallery();
player.vr().hideGallery();
player.vr().toggleGallery();
```

## API Reference

### Options

```js
player.vr({
  // Projection mode
  projection: '360',           // See projection types above
  sphereDetail: 32,            // Sphere mesh detail (higher = smoother)

  // VR HUD options
  enableVRHUD: true,           // Enable in-VR controls
  enableVRGallery: true,       // Enable in-VR media gallery
  showHUDOnStart: true,        // Show HUD when entering VR
  hudAutoHideDelay: 5000,      // Auto-hide HUD after ms (0 to disable)
  hudDistance: 1.5,            // Distance of HUD from viewer
  hudHeight: 1.5,              // Height of HUD
  hudScale: 0.015,             // Scale of HUD elements

  // Behavior options
  forceCardboard: false,       // Force cardboard button on all devices
  motionControls: true,        // Enable gyroscope/device orientation
  disableTogglePlay: false,    // Disable click-to-play

  // Spatial audio (requires Omnitone library)
  omnitone: null,              // Pass Omnitone library object
  omnitoneOptions: {},         // Omnitone configuration

  // Media gallery items
  mediaItems: [],              // Array of media items for gallery

  // Callbacks
  onNext: () => {},            // Called when next button pressed
  onPrevious: () => {},        // Called when previous button pressed
  onMediaSelect: (item, index) => {}, // Called when gallery item selected
  onGallery: () => {},         // Called when gallery button pressed
  onExit: () => {},            // Called when exit VR pressed
  onProjectionChange: (projection) => {}, // Called when projection changed
  onFavorite: () => {}         // Called when favorite button pressed (enables button)
});
```

### Methods

```js
const vr = player.vr();

// Projection
vr.setProjection('360_LR');    // Change projection mode

// VR HUD
vr.showHUD();                  // Show the VR HUD
vr.hideHUD();                  // Hide the VR HUD
vr.toggleHUD();                // Toggle HUD visibility

// VR Gallery
vr.showGallery();              // Show the gallery panel
vr.hideGallery();              // Hide the gallery panel
vr.toggleGallery();            // Toggle gallery visibility
vr.setGalleryItems(items);     // Update gallery media items

// Favorite state
vr.setFavoriteState(true);     // Set favorite button state
vr.getFavoriteState();         // Get current favorite state

// Orientation
vr.setOrientationOffset({ x: 0.5, y: 0, z: 0 }); // Tilt view
vr.resetOrientationOffset();   // Reset to default orientation
vr.recenter();                 // Recenter VR view

// Status
vr.isPresenting();             // Check if currently in VR mode

// Three.js access
vr.camera;                     // THREE.PerspectiveCamera
vr.scene;                      // THREE.Scene
vr.renderer;                   // THREE.WebGLRenderer
vr.cameraVector;               // Camera direction vector
```

### Events

```js
// VR-specific events
player.on('vr-next', () => {});
player.on('vr-previous', () => {});
player.on('vr-gallery', () => {});
player.on('vr-exit', () => {});
player.on('vr-favorite', () => {});
player.on('vr-media-select', (e, { item, index }) => {});
player.on('vr-projection-change', (e, { projection }) => {});
player.on('vr-orientation-change', (e, euler) => {});
player.on('initialized', () => {});
```

## Custom Buttons

The favorite button is an example of how custom functionality can be added. When the `onFavorite` callback is provided, the favorite button appears in the VR HUD:

```js
player.vr({
  projection: '360',
  onFavorite: () => {
    const isFavorited = !player.vr().getFavoriteState();
    player.vr().setFavoriteState(isFavorited);

    // Save to your backend
    saveFavoriteStatus(currentVideoId, isFavorited);
  }
});

// Update favorite state when loading a new video
player.on('loadedmetadata', () => {
  const isFavorited = checkIfFavorited(currentVideoId);
  player.vr().setFavoriteState(isFavorited);
});
```

## Per-Source Projection

Set projection on a source-by-source basis using `player.mediainfo`:

```js
player.mediainfo = {
  projection: '360_LR'  // This video is side-by-side 360
};

player.vr({ projection: 'AUTO' }); // Will use mediainfo.projection
```

## Accessing Three.js Objects

For advanced customization, Three.js objects are exposed:

```js
const vr = player.vr();

// Add custom objects to the scene
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const cube = new THREE.Mesh(geometry, material);
cube.position.set(0, 0, -5);
vr.scene.add(cube);

// Access camera for custom positioning
console.log(vr.camera.position);
console.log(vr.cameraVector); // Direction camera is facing
```

## Caveats

- HLS captions on Safari will not be visible as they are located inside the shadowRoot in the video element
- Some older mobile browsers may have limited WebXR support
- CORS headers are required for cross-origin video sources

## Development

```sh
# Install dependencies
npm install

# Start development server
npm start

# Run tests
npm test

# Build for production
npm run build-prod
```

## License

MIT

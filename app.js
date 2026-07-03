import { parseGIF, decompressFrames } from 'https://esm.sh/gifuct-js@2.1.2';

// iOS Safari ignores user-scalable=no, so block pinch-zoom gestures manually.
document.addEventListener('gesturestart', (e) => e.preventDefault());

// Pause playback when the app goes to the background
document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
});
window.addEventListener('pagehide', () => pause());

// Pinch-to-zoom / pan state for the preview canvas (scale 1x..4x)
const zoom = {
    scale: 1,
    tx: 0,
    ty: 0,
    minScale: 1,
    maxScale: 4,
    suppressClick: false,
};

// Crop selection overlay, shown only while zoomed in (scale > 1).
// x/y/w/h live in container CSS pixels; mapped to source pixels on export.
const CROP_MIN_SIZE = 50; // minimum crop box, in container px
const crop = {
    active: false,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
};
// In-flight crop drag (move or corner resize)
const cropDrag = {
    mode: null,        // 'move' | 'tl' | 'tr' | 'bl' | 'br'
    pointerId: null,
    startX: 0,
    startY: 0,
    startBox: null,
    moved: false,      // exceeded the tap threshold (a real drag, not a tap)
};

// --- State Management ---
const state = {
    mediaType: null,      // 'video' | 'gif'
    fileName: '',
    duration: 0,          // in seconds
    fps: 30,              // default fallback for video
    totalFrames: 0,
    currentFrameIndex: 0,
    isPlaying: false,
    
    // Video specific
    videoWidth: 0,
    videoHeight: 0,

    // View rotation in degrees (0 | 90 | 180 | 270), applied to canvas + export
    rotation: 0,
    
    // GIF specific
    gifFrames: [],        // Array of ImageBitmap objects
    gifDelays: [],        // Delay for each frame in ms
    gifAccumulatedTimes: [], // Cumulative start time for each frame
    gifTimer: null,
    
    // Export Settings
    exportFormat: 'png',  // 'png' | 'jpeg' | 'webp'
    exportQuality: 0.9,   // 0.1 - 1.0
    autoDownload: true
};

// --- DOM Elements ---
const el = {
    appContainer: document.getElementById('app-container'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('file-input'),
    demoBtn: document.getElementById('demo-btn'),
    workspace: document.getElementById('workspace'),
    
    // Preview & Video
    previewCanvas: document.getElementById('preview-canvas'),
    cropOverlay: document.getElementById('crop-overlay'),
    cropBox: document.getElementById('crop-box'),
    cropSize: document.getElementById('crop-size'),
    previewControls: document.getElementById('preview-controls'),
    btnResetView: document.getElementById('btn-reset-view'),
    btnRotateView: document.getElementById('btn-rotate-view'),
    sourceVideo: document.getElementById('source-video'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingMessage: document.getElementById('loading-message'),
    
    // Scrubber & Playback
    timelineThumbnails: document.getElementById('timeline-thumbnails'),
    timelineTrack: document.querySelector('.timeline-track-container'),
    timelinePlayhead: document.getElementById('timeline-playhead'),
    currentTime: document.getElementById('current-time'),
    totalTime: document.getElementById('total-time'),
    detailDial: document.getElementById('detail-dial'),
    frameCounter: document.getElementById('frame-counter'),
    
    // Info Panel
    btnBackHeader: document.getElementById('btn-back-header'),
    btnInfoHeader: document.getElementById('btn-info-header'),
    btnSettingsHeader: document.getElementById('btn-settings-header'),
    infoPopover: document.getElementById('info-popover'),
    settingsPopover: document.getElementById('settings-popover'),
    infoName: document.getElementById('info-name'),
    infoType: document.getElementById('info-type'),
    infoResolution: document.getElementById('info-resolution'),
    infoFrames: document.getElementById('info-frames'),
    
    // Export Settings
    formatTabs: document.querySelectorAll('.format-tab'),
    qualitySetting: document.getElementById('quality-setting'),
    exportQuality: document.getElementById('export-quality'),
    qualityValue: document.getElementById('quality-value'),
    btnExtract: document.getElementById('btn-extract'),
};

// --- Canvas Context ---
const ctx = el.previewCanvas.getContext('2d');

// --- Event Listeners Setup ---
function init() {
    // File upload drag & drop
    el.dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.dropzone.classList.add('dragover');
    });
    el.dropzone.addEventListener('dragleave', () => {
        el.dropzone.classList.remove('dragover');
    });
    el.dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        el.dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });
    
    el.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });
    
    // Demo video loader
    if (el.demoBtn) {
        el.demoBtn.addEventListener('click', loadDemoVideo);
    }
    
    // Close Media (Back Button)
    el.btnBackHeader.addEventListener('click', closeMedia);

    // Header popovers: media info ("i") and export settings (gear)
    el.btnInfoHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleInfoPopover();
    });
    el.btnSettingsHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSettingsPopover();
    });
    // Close a popover when clicking/tapping outside it and its button
    document.addEventListener('click', (e) => {
        if (el.infoPopover.style.display !== 'none'
            && !el.infoPopover.contains(e.target)
            && !el.btnInfoHeader.contains(e.target)) {
            closeInfoPopover();
        }
        if (el.settingsPopover.style.display !== 'none'
            && !el.settingsPopover.contains(e.target)
            && !el.btnSettingsHeader.contains(e.target)) {
            closeSettingsPopover();
        }
    });
    
    // Scrubber: drag/tap anywhere on the timeline track
    setupScrubbing();

    // Detail dial: fine scrubbing ruler synced with the timeline
    setupDetailDial();
    
    // Format Selection Tabs
    el.formatTabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            el.formatTabs.forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            
            const format = e.target.dataset.format;
            state.exportFormat = format;
            
            // Quality slider is only relevant for JPEG and WebP
            if (format === 'png') {
                el.qualitySetting.style.display = 'none';
            } else {
                el.qualitySetting.style.display = 'flex';
            }
        });
    });
    
    // Quality Slider
    el.exportQuality.addEventListener('input', (e) => {
        const val = e.target.value;
        el.qualityValue.textContent = `${val}%`;
        state.exportQuality = val / 100;
    });
    
    // Tap the preview to toggle play / pause (skip if the gesture was a pan/pinch)
    el.previewCanvas.addEventListener('click', () => {
        if (zoom.suppressClick) { zoom.suppressClick = false; return; }
        if (state.mediaType) togglePlayPause();
    });

    setupPreviewZoom();
    setupCropUI();

    // Floating preview controls: rotate 90° and reset crop/zoom
    el.btnResetView.addEventListener('click', (e) => {
        e.stopPropagation();
        resetView();
    });
    el.btnRotateView.addEventListener('click', (e) => {
        e.stopPropagation();
        rotateView();
    });
    // Keep the container's pan/tap gesture handlers from also reacting to the buttons
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown'].forEach((evt) => {
        el.previewControls.addEventListener(evt, (e) => e.stopPropagation());
    });

    // Extract Button (Save)
    el.btnExtract.addEventListener('click', () => extractCurrentFrame(false));
    
    // Keyboard Hotkeys
    window.addEventListener('keydown', handleGlobalKeydowns);

    // Block dragging anything (images/canvas) across the app
    window.addEventListener('dragstart', (e) => e.preventDefault());
}

// --- File Handling Logic ---
function handleFile(file) {
    resetZoom();
    state.rotation = 0;
    state.fileName = file.name;
    const fileType = file.type;
    
    if (fileType === 'image/gif') {
        loadGIF(file);
    } else if (fileType.startsWith('video/')) {
        loadVideo(file);
    } else {
        alert('지원되지 않는 파일 형식입니다. MP4, MOV 비디오 또는 GIF 파일을 올려주세요.');
    }
}

// --- Show / Hide Loader Overlay ---
function showLoader(msg) {
    el.loadingMessage.textContent = msg;
    el.loadingOverlay.style.display = 'flex';
}

function hideLoader() {
    el.loadingOverlay.style.display = 'none';
}

// --- 1. Video Loading & Preparation ---
async function loadVideo(fileOrUrl) {
    showLoader('비디오 불러오는 중...');
    state.mediaType = 'video';
    
    // Set up source url
    let videoUrl;
    if (fileOrUrl instanceof File) {
        videoUrl = URL.createObjectURL(fileOrUrl);
        el.infoName.textContent = state.fileName;
    } else {
        videoUrl = fileOrUrl;
        state.fileName = 'demo_sample.mp4';
        el.infoName.textContent = '데모 비디오';
    }
    
    // iOS Safari won't load metadata for an unmuted <video> without a play
    // gesture, so 'loadedmetadata' never fires and the app stays stuck on the
    // dropzone. Muting before load() lets iOS load metadata right away (same
    // pattern as the offscreen thumbnail video); audio is restored below.
    el.sourceVideo.muted = true;

    // Wait for video metadata to load
    el.sourceVideo.onloadedmetadata = async () => {
        el.sourceVideo.muted = false;
        state.duration = el.sourceVideo.duration;
        state.videoWidth = el.sourceVideo.videoWidth;
        state.videoHeight = el.sourceVideo.videoHeight;
        
        // Approximate standard frame rate since web video tag doesn't provide it
        // We'll estimate based on standard categories or default to 30fps
        state.fps = 30; 
        state.totalFrames = Math.floor(state.duration * state.fps);
        state.currentFrameIndex = 0;
        
        // Setup Info Panel
        el.infoType.textContent = '동영상 (MP4/MOV)';
        el.infoResolution.textContent = `${state.videoWidth} x ${state.videoHeight}`;
        el.infoFrames.textContent = `~${state.totalFrames} 프레임`;
        
        // Setup Canvas aspect ratio
        el.previewCanvas.width = state.videoWidth;
        el.previewCanvas.height = state.videoHeight;
        
        // Format Total Time
        el.totalTime.textContent = formatTime(state.duration);
        el.currentTime.textContent = formatTime(0);
        
        // Show Workspace
        el.dropzone.style.display = 'none';
        el.workspace.style.display = 'grid';
        el.btnBackHeader.style.display = 'flex';
        el.btnInfoHeader.style.display = 'flex';
        el.btnSettingsHeader.style.display = 'flex';
        
        // Show the 0s frame, but draw it 0.01s after the data is loaded so the
        // frame is actually decoded (drawing too early can yield a blank frame).
        el.sourceVideo.currentTime = 0;
        await waitForVideoReady();
        await new Promise(resolve => setTimeout(resolve, 10));
        drawVideoFrameToCanvas();
        updateTimelinePlayhead(0);
        updateFrameCounter();
        showCropUI();

        // Generate beautiful timeline thumbnails asynchronously
        generateVideoThumbnails(videoUrl);
        hideLoader();
    };
    
    el.sourceVideo.onerror = () => {
        hideLoader();
        alert('비디오를 로드하는 도중 오류가 발생했습니다. 브라우저에서 인코딩을 지원하지 않는 코덱일 수 있습니다.');
    };

    // Register handlers above before kicking off the load so a fast blob-URL
    // metadata event can't fire before we're listening.
    el.sourceVideo.src = videoUrl;
    el.sourceVideo.load();
}

// Wait until the video has frame data available (with a timeout fallback)
function waitForVideoReady(timeoutMs = 3000) {
    return new Promise(resolve => {
        const v = el.sourceVideo;
        if (v.readyState >= 2) return resolve(); // HAVE_CURRENT_DATA: frame ready
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            v.removeEventListener('loadeddata', finish);
            resolve();
        };
        v.addEventListener('loadeddata', finish);
        setTimeout(finish, timeoutMs);
    });
}

// Wait for video seek to complete (with a timeout fallback so a missing
// 'seeked' event can never hang loading/scrubbing)
function waitForSeek(timeoutMs = 3000) {
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            el.sourceVideo.removeEventListener('seeked', onSeeked);
            resolve();
        };
        const onSeeked = () => finish();
        el.sourceVideo.addEventListener('seeked', onSeeked);
        setTimeout(finish, timeoutMs);
    });
}

// Size a canvas to hold the current frame, swapping w/h for 90°/270° rotation
function sizeCanvasForRotation(canvas) {
    if (state.rotation === 90 || state.rotation === 270) {
        canvas.width = state.videoHeight;
        canvas.height = state.videoWidth;
    } else {
        canvas.width = state.videoWidth;
        canvas.height = state.videoHeight;
    }
}

// Draw a source (video frame or GIF bitmap) into a context, applying the
// current rotation. The context's canvas must already be sized via
// sizeCanvasForRotation().
function drawSourceRotated(targetCtx, source) {
    const cw = targetCtx.canvas.width;
    const ch = targetCtx.canvas.height;
    targetCtx.clearRect(0, 0, cw, ch);
    targetCtx.save();
    targetCtx.translate(cw / 2, ch / 2);
    targetCtx.rotate(state.rotation * Math.PI / 180);
    targetCtx.drawImage(
        source,
        -state.videoWidth / 2, -state.videoHeight / 2,
        state.videoWidth, state.videoHeight,
    );
    targetCtx.restore();
}

// Redraw the current frame (used after a rotation change)
function redrawCurrentFrame() {
    if (state.mediaType === 'video') {
        drawVideoFrameToCanvas();
    } else if (state.mediaType === 'gif') {
        drawGIFFrame(state.currentFrameIndex);
    }
}

// Draw current video frame to display canvas
function drawVideoFrameToCanvas() {
    drawSourceRotated(ctx, el.sourceVideo);
}

// Generate background strip of thumbnails for video timeline
async function generateVideoThumbnails(videoUrl) {
    el.timelineThumbnails.innerHTML = '';
    const numThumbs = 10;
    const interval = state.duration / numThumbs;
    
    // Create temporary offscreen video to generate thumbnails in background
    const offscreenVideo = document.createElement('video');
    offscreenVideo.src = videoUrl;
    offscreenVideo.muted = true;
    offscreenVideo.playsInline = true;
    offscreenVideo.load();
    
    await new Promise(resolve => {
        offscreenVideo.onloadedmetadata = resolve;
    });
    
    const thumbCanvas = document.createElement('canvas');
    const tCtx = thumbCanvas.getContext('2d');
    // Thumbnail resolution
    thumbCanvas.width = 120;
    thumbCanvas.height = Math.round(120 * (state.videoHeight / state.videoWidth));
    
    for (let i = 0; i < numThumbs; i++) {
        const seekTime = Math.min(state.duration, i * interval + (interval / 2));
        offscreenVideo.currentTime = seekTime;
        
        await new Promise(resolve => {
            offscreenVideo.onseeked = resolve;
        });
        // Let the frame finish decoding/painting before capturing it,
        // otherwise the thumbnail (especially the first) can come out black.
        await new Promise(resolve => setTimeout(resolve, 30));

        tCtx.clearRect(0, 0, thumbCanvas.width, thumbCanvas.height);
        tCtx.drawImage(offscreenVideo, 0, 0, thumbCanvas.width, thumbCanvas.height);
        
        const img = document.createElement('img');
        img.src = thumbCanvas.toDataURL('image/jpeg', 0.6);
        img.className = 'timeline-thumbnail-frame';
        el.timelineThumbnails.appendChild(img);
    }
}

// --- 2. GIF Loading & Rendering with robust frame-caching ---
async function loadGIF(file) {
    showLoader('GIF 파일 읽는 중...');
    state.mediaType = 'gif';
    el.infoName.textContent = file.name;
    
    try {
        const buffer = await file.arrayBuffer();
        showLoader('GIF 프레임 디코딩 중...');
        
        const parsedGif = parseGIF(buffer);
        const decompressed = decompressFrames(parsedGif, true); // true = build patches for canvas
        
        state.totalFrames = decompressed.length;
        state.gifFrames = [];
        state.gifDelays = [];
        state.gifAccumulatedTimes = [];
        
        // Find dimensions from parsed header
        const width = parsedGif.lsd.width;
        const height = parsedGif.lsd.height;
        
        state.videoWidth = width;
        state.videoHeight = height;
        
        // Setup Canvas dimensions
        el.previewCanvas.width = width;
        el.previewCanvas.height = height;
        
        // Temporary canvases for accumulator
        const accumulatedCanvas = document.createElement('canvas');
        accumulatedCanvas.width = width;
        accumulatedCanvas.height = height;
        const accumCtx = accumulatedCanvas.getContext('2d');
        
        // Backup canvas for disposal type 3 (restore previous)
        const previousCanvas = document.createElement('canvas');
        previousCanvas.width = width;
        previousCanvas.height = height;
        const prevCtx = previousCanvas.getContext('2d');
        
        let cumulativeTime = 0;
        
        // Sequential Pre-render and caching loop (solves disposal method glitches completely)
        for (let i = 0; i < decompressed.length; i++) {
            const frame = decompressed[i];
            
            // Handle Disposal Method
            // 0: No action
            // 1: Do not dispose (drawn over previous frame)
            // 2: Restore to background color (clear current patch area)
            // 3: Restore to previous (restore to state prior to drawing this frame)
            
            let backupData = null;
            if (frame.disposalType === 3) {
                backupData = accumCtx.getImageData(0, 0, width, height);
            }
            
            if (frame.disposalType === 2) {
                accumCtx.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
            }
            
            // Draw patch
            const patchCanvas = document.createElement('canvas');
            patchCanvas.width = frame.dims.width;
            patchCanvas.height = frame.dims.height;
            const pCtx = patchCanvas.getContext('2d');
            
            const imgData = new ImageData(frame.patch, frame.dims.width, frame.dims.height);
            pCtx.putImageData(imgData, 0, 0);
            
            // Draw patch onto accumulated canvas
            accumCtx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);
            
            // Create a hardware-accelerated ImageBitmap from the fully assembled canvas frame
            const frameBitmap = await createImageBitmap(accumulatedCanvas);
            state.gifFrames.push(frameBitmap);
            
            // Delay in ms (fallback to 100ms if 0)
            const delay = frame.delay || 100;
            state.gifDelays.push(delay);
            state.gifAccumulatedTimes.push(cumulativeTime);
            
            cumulativeTime += (delay / 1000);
            
            // After drawing, perform post-disposal cleanup
            if (frame.disposalType === 3 && backupData) {
                accumCtx.putImageData(backupData, 0, 0);
            }
        }
        
        state.duration = cumulativeTime;
        state.currentFrameIndex = 0;
        
        // Setup Info Panel
        el.infoType.textContent = '움직이는 이미지 (GIF)';
        el.infoResolution.textContent = `${width} x ${height}`;
        el.infoFrames.textContent = `${state.totalFrames} 프레임`;
        
        el.totalTime.textContent = formatTime(state.duration);
        el.currentTime.textContent = formatTime(0);
        
        // Show Workspace
        el.dropzone.style.display = 'none';
        el.workspace.style.display = 'grid';
        el.btnBackHeader.style.display = 'flex';
        el.btnInfoHeader.style.display = 'flex';
        el.btnSettingsHeader.style.display = 'flex';
        
        // Render first frame
        drawGIFFrame(0);
        updateTimelinePlayhead(0);
        updateFrameCounter();
        showCropUI();

        // Generate timeline thumbnails from cached frames
        generateGIFThumbnails();
        hideLoader();
        
    } catch (err) {
        hideLoader();
        console.error(err);
        alert('GIF 파일을 파싱하는 데 실패했습니다. 파일이 손상되었거나 지원하지 않는 GIF 구조일 수 있습니다.');
    }
}

// Draw cached GIF frame to display canvas
function drawGIFFrame(index) {
    if (index < 0 || index >= state.gifFrames.length) return;
    drawSourceRotated(ctx, state.gifFrames[index]);
}

// Generate thumbnail strip for GIF timeline
function generateGIFThumbnails() {
    el.timelineThumbnails.innerHTML = '';
    const numThumbs = 10;
    const step = Math.max(1, Math.floor(state.totalFrames / numThumbs));
    
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 120;
    thumbCanvas.height = Math.round(120 * (state.videoHeight / state.videoWidth));
    const tCtx = thumbCanvas.getContext('2d');
    
    for (let i = 0; i < numThumbs; i++) {
        const frameIdx = Math.min(state.totalFrames - 1, i * step);
        const bitmap = state.gifFrames[frameIdx];
        
        if (!bitmap) continue;
        
        tCtx.clearRect(0, 0, thumbCanvas.width, thumbCanvas.height);
        tCtx.drawImage(bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height);
        
        const img = document.createElement('img');
        img.src = thumbCanvas.toDataURL('image/jpeg', 0.6);
        img.className = 'timeline-thumbnail-frame';
        el.timelineThumbnails.appendChild(img);
    }
}

// --- 3. Playback / Play-Pause Loops ---
let animationFrameId = null;

function togglePlayPause() {
    if (state.isPlaying) {
        pause();
    } else {
        play();
    }
}

function play() {
    if (state.isPlaying) return;
    state.isPlaying = true;

    if (state.mediaType === 'video') {
        el.sourceVideo.play();
        playVideoLoop();
    } else if (state.mediaType === 'gif') {
        playGIFLoop();
    }
}

function pause() {
    if (!state.isPlaying) return;
    state.isPlaying = false;

    if (state.mediaType === 'video') {
        el.sourceVideo.pause();
        cancelAnimationFrame(animationFrameId);
    } else if (state.mediaType === 'gif') {
        clearTimeout(state.gifTimer);
    }
}

// Sync video rendering with screen refresh while playing
function playVideoLoop() {
    if (!state.isPlaying) return;
    
    drawVideoFrameToCanvas();
    const curTime = el.sourceVideo.currentTime;
    
    state.currentFrameIndex = Math.min(state.totalFrames - 1, Math.floor(curTime * state.fps));
    el.currentTime.textContent = formatTime(curTime);
    updateFrameCounter();
    
    const pct = curTime / state.duration;
    updateTimelinePlayhead(pct);
    
    if (el.sourceVideo.ended) {
        pause();
        state.currentFrameIndex = state.totalFrames - 1;
        updateFrameCounter();
        updateTimelinePlayhead(1);
    } else {
        animationFrameId = requestAnimationFrame(playVideoLoop);
    }
}

// Schedule GIF frame draw based on exact variable frame delays
function playGIFLoop() {
    if (!state.isPlaying) return;
    
    const drawNext = () => {
        if (!state.isPlaying) return;
        
        drawGIFFrame(state.currentFrameIndex);
        
        const curTime = state.gifAccumulatedTimes[state.currentFrameIndex];
        el.currentTime.textContent = formatTime(curTime);
        updateFrameCounter();
        
        const pct = curTime / state.duration;
        updateTimelinePlayhead(pct);
        
        const delay = state.gifDelays[state.currentFrameIndex];
        
        // Progress to next frame
        state.currentFrameIndex = (state.currentFrameIndex + 1) % state.totalFrames;
        
        // Schedule next frame precisely matching original GIF speed
        state.gifTimer = setTimeout(drawNext, delay);
    };
    
    drawNext();
}

// --- 4. Navigation & Scrubbing ---

// Step precisely +1 / -1 frame
async function stepFrame(direction) {
    pause();
    
    if (state.mediaType === 'video') {
        const frameTime = 1 / state.fps;
        let newTime = el.sourceVideo.currentTime + (direction * frameTime);
        newTime = Math.max(0, Math.min(state.duration, newTime));
        
        el.sourceVideo.currentTime = newTime;
        await waitForSeek();
        drawVideoFrameToCanvas();
        
        state.currentFrameIndex = Math.min(state.totalFrames - 1, Math.floor(newTime * state.fps));
        el.currentTime.textContent = formatTime(newTime);
        updateTimelinePlayhead(newTime / state.duration);
        updateFrameCounter();
        
    } else if (state.mediaType === 'gif') {
        let newIdx = state.currentFrameIndex + direction;
        if (newIdx < 0) newIdx = state.totalFrames - 1;
        if (newIdx >= state.totalFrames) newIdx = 0;
        
        state.currentFrameIndex = newIdx;
        drawGIFFrame(newIdx);
        
        const curTime = state.gifAccumulatedTimes[newIdx];
        el.currentTime.textContent = formatTime(curTime);
        updateTimelinePlayhead(curTime / state.duration);
        updateFrameCounter();
    }
}

// Pointer-based scrubbing: the entire track is the touch target and the
// playhead follows the finger/cursor exactly.
function setupScrubbing() {
    const track = el.timelineTrack;
    let scrubbing = false;

    const pctFromClientX = (clientX) => {
        const rect = track.getBoundingClientRect();
        const pct = (clientX - rect.left) / rect.width;
        return Math.max(0, Math.min(1, pct));
    };

    track.addEventListener('pointerdown', (e) => {
        scrubbing = true;
        try { track.setPointerCapture(e.pointerId); } catch (err) {}
        pause();
        seekToPct(pctFromClientX(e.clientX));
    });

    track.addEventListener('pointermove', (e) => {
        if (!scrubbing) return;
        seekToPct(pctFromClientX(e.clientX));
    });

    const stop = (e) => {
        scrubbing = false;
        try { track.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    track.addEventListener('pointerup', stop);
    track.addEventListener('pointercancel', stop);
}

// Coalesced video seeking: while one seek is in flight, only the latest
// requested position is kept so dragging stays responsive instead of
// queuing up every intermediate seek.
let pendingSeekTime = null;
let seekInFlight = false;

async function processVideoSeek() {
    if (seekInFlight) return;
    seekInFlight = true;
    while (pendingSeekTime !== null) {
        const target = pendingSeekTime;
        pendingSeekTime = null;
        el.sourceVideo.currentTime = target;
        await waitForSeek();
        drawVideoFrameToCanvas();
    }
    seekInFlight = false;
}

// Move playback to a position given as 0..1 along the timeline
function seekToPct(pct) {
    if (state.mediaType === 'video') {
        const seekTime = pct * state.duration;
        // Update UI immediately for instant feedback
        state.currentFrameIndex = Math.min(state.totalFrames - 1, Math.floor(seekTime * state.fps));
        el.currentTime.textContent = formatTime(seekTime);
        updateTimelinePlayhead(pct);
        updateFrameCounter();
        // Actual frame draw is coalesced to the latest position
        pendingSeekTime = seekTime;
        processVideoSeek();

    } else if (state.mediaType === 'gif') {
        const targetFrameIdx = Math.min(state.totalFrames - 1, Math.floor(pct * state.totalFrames));
        state.currentFrameIndex = targetFrameIdx;
        drawGIFFrame(targetFrameIdx);

        const curTime = state.gifAccumulatedTimes[targetFrameIdx];
        el.currentTime.textContent = formatTime(curTime);
        updateTimelinePlayhead(pct);
        updateFrameCounter();
    }
}

// --- Auxiliary UI Sync Helpers ---
function updateTimelinePlayhead(pct) {
    el.timelinePlayhead.style.left = `${pct * 100}%`;
    el.timelineTrack.style.setProperty('--playhead-pct', `${pct * 100}%`);
    drawDetailDial(pct);
}

// --- Detail Dial (fine scrubbing ruler, synced with the timeline) ---

// Current position as a 0..1 fraction of the media duration
function currentPct() {
    if (!state.duration) return 0;
    if (state.mediaType === 'video') {
        return el.sourceVideo.currentTime / state.duration;
    }
    if (state.mediaType === 'gif') {
        return (state.gifAccumulatedTimes[state.currentFrameIndex] || 0) / state.duration;
    }
    return 0;
}

// Draw the ruler: a thin tick every 0.1s, a tall/darker tick every 1s (every
// 10th), centered fixed indicator, ticks fading toward the edges.
function drawDetailDial(pct) {
    const canvas = el.detailDial;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;

    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    }

    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);

    const tickSpacing = 8;       // px between ticks
    const ticksPerSecond = 10;   // a tick every 0.1s
    const centerX = cssW / 2;
    const midY = cssH / 2;

    const currentSec = pct * state.duration;
    const centerTick = currentSec * ticksPerSecond;
    const baseTick = Math.floor(centerTick);
    const fractional = centerTick - baseTick;
    const maxTick = Math.floor(state.duration * ticksPerSecond);
    const halfCount = Math.ceil(cssW / tickSpacing / 2) + 2;

    for (let i = -halfCount; i <= halfCount; i++) {
        const tickIdx = baseTick + i;
        if (tickIdx < 0 || tickIdx > maxTick) continue;

        const x = centerX + (i - fractional) * tickSpacing;
        if (x < 0 || x > cssW) continue;

        const isMajor = tickIdx % 10 === 0;
        const h = isMajor ? 16 : 8;
        const baseOpacity = isMajor ? 0.6 : 0.3;
        const fade = Math.max(0, 1 - Math.abs(x - centerX) / (cssW / 2));

        c.strokeStyle = `rgba(255, 255, 255, ${baseOpacity * fade})`;
        c.lineWidth = isMajor ? 1.5 : 1;
        c.beginPath();
        c.moveTo(x, midY - h / 2);
        c.lineTo(x, midY + h / 2);
        c.stroke();
    }

    // Fixed center indicator
    c.strokeStyle = '#3b82f6';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(centerX, 4);
    c.lineTo(centerX, cssH - 4);
    c.stroke();
}

// Drag the dial to scrub finely (80px = 1 second), synced with the timeline
function setupDetailDial() {
    const canvas = el.detailDial;
    if (!canvas) return;

    const PX_PER_SECOND = 80; // tickSpacing(8) * ticksPerSecond(10)
    let dragging = false;
    let startX = 0;
    let startSec = 0;

    canvas.addEventListener('pointerdown', (e) => {
        if (!state.mediaType) return;
        dragging = true;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        pause();
        startX = e.clientX;
        startSec = currentPct() * state.duration;
    });

    canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        let newSec = startSec - dx / PX_PER_SECOND; // drag right = earlier
        newSec = Math.max(0, Math.min(state.duration, newSec));
        seekToPct(state.duration > 0 ? newSec / state.duration : 0);
    });

    const stop = (e) => {
        dragging = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    // Keep the dial crisp/synced on resize
    window.addEventListener('resize', () => drawDetailDial(currentPct()));
}

function updateFrameCounter() {
    el.frameCounter.textContent = `프레임: ${state.currentFrameIndex + 1} / ${state.totalFrames}`;
}

// --- Header Popovers (media info + export settings, mutually exclusive) ---
function toggleInfoPopover() {
    const isOpen = el.infoPopover.style.display !== 'none';
    closeSettingsPopover();
    if (isOpen) {
        closeInfoPopover();
    } else {
        el.infoPopover.style.display = 'block';
        el.btnInfoHeader.classList.add('active');
    }
}

function closeInfoPopover() {
    el.infoPopover.style.display = 'none';
    el.btnInfoHeader.classList.remove('active');
}

function toggleSettingsPopover() {
    const isOpen = el.settingsPopover.style.display !== 'none';
    closeInfoPopover();
    if (isOpen) {
        closeSettingsPopover();
    } else {
        el.settingsPopover.style.display = 'block';
        el.btnSettingsHeader.classList.add('active');
    }
}

function closeSettingsPopover() {
    el.settingsPopover.style.display = 'none';
    el.btnSettingsHeader.classList.remove('active');
}

// Close current workspace and return to upload dashboard
function closeMedia() {
    pause();
    
    // Clear video event handlers and source cleanly to prevent triggering error alerts on unload
    el.sourceVideo.onerror = null;
    el.sourceVideo.onloadedmetadata = null;
    el.sourceVideo.src = '';
    el.sourceVideo.removeAttribute('src');
    el.sourceVideo.load();
    
    // Clear GIF memory
    state.gifFrames.forEach(bitmap => {
        if (bitmap && typeof bitmap.close === 'function') {
            bitmap.close();
        }
    });
    state.gifFrames = [];
    
    el.workspace.style.display = 'none';
    el.dropzone.style.display = 'block';
    el.btnBackHeader.style.display = 'none';
    el.btnInfoHeader.style.display = 'none';
    el.btnSettingsHeader.style.display = 'none';
    closeInfoPopover();
    closeSettingsPopover();
    hideCropUI();
    
    // Reset state
    state.mediaType = null;
    state.fileName = '';
    state.duration = 0;
    state.totalFrames = 0;
    state.currentFrameIndex = 0;
    state.rotation = 0;
}

// --- 5. High-Resolution Frame Extraction & Exporting ---
function extractCurrentFrame(forceNewTab = false) {
    let newTab = null;
    if (forceNewTab) {
        // Open the new tab synchronously inside the gesture handler to bypass popup blockers
        newTab = window.open('', '_blank');
        if (newTab) {
            newTab.document.write(`
                <!DOCTYPE html>
                <html lang="ko">
                <head>
                    <meta charset="UTF-8">
                    <title>CapShot 프레임 미리보기</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body {
                            margin: 0;
                            background: #080a10;
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            justify-content: center;
                            min-height: 100vh;
                            color: #f3f4f6;
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
                            overflow: hidden;
                            user-select: none;
                            -webkit-user-select: none;
                        }
                        .loader-container {
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            gap: 16px;
                            transition: opacity 0.3s ease;
                        }
                        .spinner {
                            width: 40px;
                            height: 40px;
                            border: 3px solid rgba(255, 255, 255, 0.1);
                            border-radius: 50%;
                            border-top-color: #3b82f6;
                            animation: spin 1s ease-in-out infinite;
                        }
                        @keyframes spin {
                            to { transform: rotate(360deg); }
                        }
                        .image-container {
                            position: absolute;
                            top: 0; left: 0; right: 0; bottom: 0;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            opacity: 0;
                            transition: opacity 0.4s ease;
                        }
                        img {
                            max-width: 100%;
                            max-height: 100%;
                            object-fit: contain;
                            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                        }
                        .hint-text {
                            position: absolute;
                            bottom: 24px;
                            background: rgba(0,0,0,0.7);
                            padding: 8px 16px;
                            border-radius: 20px;
                            font-size: 13px;
                            backdrop-filter: blur(8px);
                            -webkit-backdrop-filter: blur(8px);
                            color: #e5e7eb;
                            pointer-events: none;
                            opacity: 0;
                            transition: opacity 0.4s ease;
                            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                        }
                    </style>
                </head>
                <body>
                    <div id="loader" class="loader-container">
                        <div class="spinner"></div>
                        <div>고해상도 프레임 생성 중...</div>
                    </div>
                    <div id="img-wrapper" class="image-container">
                        <img id="preview-img" src="" alt="CapShot Frame">
                        <div id="hint" class="hint-text">이미지를 길게 누르면 저장하거나 공유할 수 있습니다.</div>
                    </div>
                </body>
                </html>
            `);
            newTab.document.close();
        }
    }

    // Create temporary full-resolution export canvas (rotation-aware size)
    const exportCanvas = document.createElement('canvas');
    sizeCanvasForRotation(exportCanvas);
    const eCtx = exportCanvas.getContext('2d');

    if (state.mediaType === 'video') {
        // Draw the current video frame at native camera capture resolution
        drawSourceRotated(eCtx, el.sourceVideo);
    } else if (state.mediaType === 'gif') {
        // Draw the cached full-resolution frame ImageBitmap
        const bitmap = state.gifFrames[state.currentFrameIndex];
        if (bitmap) {
            drawSourceRotated(eCtx, bitmap);
        }
    }

    // Crop to the selected region (crop box / zoomed view). Source dims are the
    // rotated export canvas, not the raw video dimensions.
    let outCanvas = exportCanvas;
    const cropRect = getZoomCropSource(exportCanvas.width, exportCanvas.height);
    if (cropRect) {
        const cropped = document.createElement('canvas');
        cropped.width = Math.round(cropRect.sw);
        cropped.height = Math.round(cropRect.sh);
        cropped.getContext('2d').drawImage(
            exportCanvas,
            cropRect.sx, cropRect.sy, cropRect.sw, cropRect.sh,
            0, 0, cropped.width, cropped.height,
        );
        outCanvas = cropped;
    }

    // Determine mime-type & quality parameter
    let mimeType = 'image/png';
    let ext = 'png';
    if (state.exportFormat === 'jpeg') {
        mimeType = 'image/jpeg';
        ext = 'jpg';
    } else if (state.exportFormat === 'webp') {
        mimeType = 'image/webp';
        ext = 'webp';
    }
    
    // "저장" 버튼 / Enter: save the frame.
    // Generated synchronously so navigator.share() stays within the user gesture.
    if (!forceNewTab) {
        const baseName = state.fileName.substring(0, state.fileName.lastIndexOf('.')) || 'CapShot';
        const filename = `${baseName}_frame_${state.currentFrameIndex + 1}.${ext}`;
        saveFrame(outCanvas, mimeType, filename);
        return;
    }

    // Canvas tap: render the high-res frame into the opened preview tab
    outCanvas.toBlob((blob) => {
        if (!blob) {
            alert('이미지 추출에 실패했습니다.');
            if (newTab) newTab.close();
            return;
        }

        const url = URL.createObjectURL(blob);

        if (newTab && !newTab.closed) {
            const img = newTab.document.getElementById('preview-img');
            const loader = newTab.document.getElementById('loader');
            const imgWrapper = newTab.document.getElementById('img-wrapper');
            const hint = newTab.document.getElementById('hint');

            if (img) {
                img.onload = () => {
                    if (loader) loader.style.opacity = '0';
                    setTimeout(() => {
                        if (loader) loader.style.display = 'none';
                        if (imgWrapper) imgWrapper.style.opacity = '1';
                        if (hint) hint.style.opacity = '1';
                    }, 300);
                };
                img.src = url;
            }
        }
    }, mimeType, state.exportFormat === 'png' ? undefined : state.exportQuality);
}

// Convert a data URL into a Blob synchronously (keeps the user gesture alive
// for navigator.share, unlike the async canvas.toBlob).
function dataURLToBlob(dataURL) {
    const [header, base64] = dataURL.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}

// Treat coarse-pointer / touch devices as mobile (more robust than UA sniffing)
function isMobileDevice() {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

// Save a frame, branching by device:
//  - Mobile: native share sheet so the user can save to the photo album
//    (requires HTTPS — navigator.canShare is false on plain HTTP)
//  - Desktop: direct file download
async function saveFrame(canvas, mimeType, filename) {
    const quality = state.exportFormat === 'png' ? undefined : state.exportQuality;
    const dataUrl = canvas.toDataURL(mimeType, quality);
    const blob = dataURLToBlob(dataUrl);
    const file = new File([blob], filename, { type: mimeType });

    const canShareFile = navigator.canShare && navigator.canShare({ files: [file] });

    if (isMobileDevice() && canShareFile) {
        // Mobile → OS share sheet ("사진에 저장 / 이미지 저장")
        try {
            await navigator.share({ files: [file], title: 'CapShot' });
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return; // user cancelled
            // any other failure falls through to download
        }
    }

    // Desktop (or share unavailable) → download
    downloadBlob(blob, filename);
}

// Trigger a browser download for a blob
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = filename;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Load preconfigured online demo video
function loadDemoVideo() {
    state.fileName = 'capshot_demo.mp4';
    // Reliable public open-source sample video
    const demoUrl = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';
    loadVideo(demoUrl);
}

// Handle global hotkeys for extreme convenience
function handleGlobalKeydowns(e) {
    // Disable shortcuts if focus is inside some input (though none are currently text inputs)
    if (document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') return;
    
    if (state.mediaType) {
        if (e.code === 'Space') {
            e.preventDefault();
            togglePlayPause();
        } else if (e.code === 'ArrowLeft') {
            e.preventDefault();
            stepFrame(-1);
        } else if (e.code === 'ArrowRight') {
            e.preventDefault();
            stepFrame(1);
        } else if (e.code === 'Enter') {
            e.preventDefault();
            extractCurrentFrame();
        }
    }
}

// Formats seconds into MM:SS.CC (Minutes:Seconds.Centiseconds)
function formatTime(secs) {
    if (isNaN(secs)) return '00:00.00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const c = Math.floor((secs % 1) * 100);
    
    const mm = m < 10 ? '0' + m : m;
    const ss = s < 10 ? '0' + s : s;
    const cc = c < 10 ? '0' + c : c;
    
    return `${mm}:${ss}.${cc}`;
}

// --- Preview pinch-zoom & pan (1x..4x) ---
function applyZoomTransform() {
    el.previewCanvas.style.transform =
        `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
    syncCropUI();
    updateCropSizeLabel();
}

// --- Crop overlay (visible only while zoomed in) ---

// The crop UI is present whenever media is loaded (both at 1x and zoomed in).
function syncCropUI() {
    const shouldShow = !!state.mediaType;
    if (shouldShow && !crop.active) {
        showCropUI();
    } else if (!shouldShow && crop.active) {
        hideCropUI();
    }
}

// Reset the crop box to the actual video display rect (letterbox excluded)
// and reveal the overlay.
function showCropUI() {
    // Default crop = the actual displayed video rect (letterbox excluded)
    const rect = videoDisplayRect();
    crop.w = rect.dispW;
    crop.h = rect.dispH;
    crop.x = Math.max(0, rect.x);
    crop.y = Math.max(0, rect.y);
    crop.active = true;
    el.cropOverlay.style.display = 'block';
    el.previewControls.style.display = 'flex';
    updateCropBoxStyle();
}

function hideCropUI() {
    crop.active = false;
    cancelCropDrag();
    el.cropOverlay.style.display = 'none';
    el.previewControls.style.display = 'none';
}

// Restore the crop box and zoom to their defaults (1x, full video rect)
function resetView() {
    resetZoom();   // scale 1, tx/ty 0
    showCropUI();  // crop box back to the full video rect
}

// Rotate the view 90° clockwise; resets zoom and crop to fit the new aspect
function rotateView() {
    if (!state.mediaType) return;
    state.rotation = (state.rotation + 90) % 360;
    sizeCanvasForRotation(el.previewCanvas);
    redrawCurrentFrame();
    resetView();
}

function updateCropBoxStyle() {
    el.cropBox.style.left = `${crop.x}px`;
    el.cropBox.style.top = `${crop.y}px`;
    el.cropBox.style.width = `${crop.w}px`;
    el.cropBox.style.height = `${crop.h}px`;
    updateCropSizeLabel();
}

// Show the crop's actual output size in source pixels (w:h, thousands-comma),
// which reflects the current crop box, zoom and rotation.
function updateCropSizeLabel() {
    if (!crop.active) return;
    const rotated = state.rotation === 90 || state.rotation === 270;
    const srcW = rotated ? state.videoHeight : state.videoWidth;
    const srcH = rotated ? state.videoWidth : state.videoHeight;
    const rect = getZoomCropSource(srcW, srcH);
    const w = rect ? Math.round(rect.sw) : srcW;
    const h = rect ? Math.round(rect.sh) : srcH;
    el.cropSize.textContent = `${w.toLocaleString('en-US')}×${h.toLocaleString('en-US')}`;
}

function cancelCropDrag() {
    cropDrag.mode = null;
    cropDrag.pointerId = null;
    cropDrag.startBox = null;
}

// True when a gesture started on the crop box/handles (so the container's
// pan/pinch handlers should leave it to the crop logic instead)
function isCropTarget(target) {
    return crop.active && target instanceof Element && !!target.closest('.crop-box');
}

// Move / resize the crop box. Handles are children of the box, so a handle
// pointerdown must stopPropagation to avoid also triggering a box "move".
function setupCropUI() {
    const box = el.cropBox;
    const container = el.previewCanvas.parentElement;

    const DOUBLE_TAP_MS = 250;
    const TAP_SLOP = 4; // px of movement still considered a tap
    let lastTapTime = 0;
    let tapTimer = null;

    const beginDrag = (e, mode) => {
        // A second pointer means a pinch is starting — abandon the crop drag
        if (cropDrag.mode !== null) {
            cancelCropDrag();
            return;
        }
        e.preventDefault();
        cropDrag.mode = mode;
        cropDrag.pointerId = e.pointerId;
        cropDrag.startX = e.clientX;
        cropDrag.startY = e.clientY;
        cropDrag.startBox = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
        cropDrag.moved = false;
    };

    box.addEventListener('pointerdown', (e) => beginDrag(e, 'move'));

    box.querySelectorAll('.crop-handle').forEach((handle) => {
        handle.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            beginDrag(e, handle.dataset.handle);
        });
    });

    window.addEventListener('pointermove', (e) => {
        if (cropDrag.mode === null || e.pointerId !== cropDrag.pointerId) return;
        e.preventDefault();

        const contW = container.clientWidth;
        const contH = container.clientHeight;
        const dx = e.clientX - cropDrag.startX;
        const dy = e.clientY - cropDrag.startY;
        const s = cropDrag.startBox;

        if (cropDrag.mode === 'move') {
            // Ignore tiny jitter so a tap isn't mistaken for a drag
            if (!cropDrag.moved && Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP) return;
            cropDrag.moved = true;
            crop.x = Math.max(0, Math.min(contW - s.w, s.x + dx));
            crop.y = Math.max(0, Math.min(contH - s.h, s.y + dy));
        } else {
            // Resize by moving one corner; the opposite corner stays fixed.
            let left = s.x;
            let top = s.y;
            let right = s.x + s.w;
            let bottom = s.y + s.h;

            if (cropDrag.mode.includes('l')) {
                left = Math.max(0, Math.min(right - CROP_MIN_SIZE, s.x + dx));
            }
            if (cropDrag.mode.includes('r')) {
                right = Math.min(contW, Math.max(left + CROP_MIN_SIZE, s.x + s.w + dx));
            }
            if (cropDrag.mode.includes('t')) {
                top = Math.max(0, Math.min(bottom - CROP_MIN_SIZE, s.y + dy));
            }
            if (cropDrag.mode.includes('b')) {
                bottom = Math.min(contH, Math.max(top + CROP_MIN_SIZE, s.y + s.h + dy));
            }

            crop.x = left;
            crop.y = top;
            crop.w = right - left;
            crop.h = bottom - top;
        }

        updateCropBoxStyle();
    }, { passive: false });

    const endDrag = (e) => {
        if (e.pointerId !== cropDrag.pointerId) return;
        const wasMove = cropDrag.mode === 'move';
        const moved = cropDrag.moved;
        cancelCropDrag();

        // A tap inside the box (no drag) keeps the old play / double-tap-zoom UX,
        // since the box now overlays the whole video.
        if (!wasMove || moved) return;

        const now = e.timeStamp;
        if (now - lastTapTime < DOUBLE_TAP_MS) {
            if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
            if (zoom.scale > 1.01) {
                resetZoom();
            } else {
                zoomToPoint(e.clientX, e.clientY, 2);
            }
            lastTapTime = 0;
        } else {
            lastTapTime = now;
            if (tapTimer) clearTimeout(tapTimer);
            tapTimer = setTimeout(() => {
                tapTimer = null;
                if (state.mediaType) togglePlayPause();
            }, DOUBLE_TAP_MS + 40);
        }
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
}

function resetZoom() {
    zoom.scale = 1;
    zoom.tx = 0;
    zoom.ty = 0;
    applyZoomTransform();
}

// Zoom to a target scale while keeping the given screen point fixed (works from any current state)
function zoomToPoint(clientX, clientY, newScale) {
    const rect = el.previewCanvas.parentElement.getBoundingClientRect();
    const ccx = rect.left + rect.width / 2;
    const ccy = rect.top + rect.height / 2;
    const s = zoom.scale;
    const ns = Math.max(zoom.minScale, Math.min(zoom.maxScale, newScale));
    const ax = clientX - ccx;
    const ay = clientY - ccy;
    zoom.tx = ax - (ns / s) * (ax - zoom.tx);
    zoom.ty = ay - (ns / s) * (ay - zoom.ty);
    zoom.scale = ns;
    clampZoomPan();
    applyZoomTransform();
}

// Keep the panned/scaled canvas from drifting outside the container
function clampZoomPan() {
    const w = el.previewCanvas.offsetWidth;
    const h = el.previewCanvas.offsetHeight;
    const maxX = (zoom.scale - 1) * w / 2;
    const maxY = (zoom.scale - 1) * h / 2;
    zoom.tx = Math.max(-maxX, Math.min(maxX, zoom.tx));
    zoom.ty = Math.max(-maxY, Math.min(maxY, zoom.ty));
}

// Map the currently visible (zoomed) region back to source pixels for cropping.
// Returns {sx, sy, sw, sh} in source-image coordinates, or null when not zoomed.
// The actual on-screen video rect (object-fit: contain math, rotation-aware),
// in container coordinates. Independent of the canvas element's box quirks and
// layout timing, so it never falls back to the full container by mistake.
function videoDisplayRect() {
    const container = el.previewCanvas.parentElement;
    const contW = container.clientWidth;
    const contH = container.clientHeight;
    const rotated = state.rotation === 90 || state.rotation === 270;
    const vidW = rotated ? state.videoHeight : state.videoWidth;
    const vidH = rotated ? state.videoWidth : state.videoHeight;
    if (!vidW || !vidH || !contW || !contH) {
        return { x: 0, y: 0, dispW: contW, dispH: contH };
    }
    const scale = Math.min(contW / vidW, contH / vidH);
    const dispW = vidW * scale;
    const dispH = vidH * scale;
    return { x: (contW - dispW) / 2, y: (contH - dispH) / 2, dispW, dispH };
}

function getZoomCropSource(srcW, srcH) {
    if (zoom.scale <= 1.01 && !crop.active) return null;
    const container = el.previewCanvas.parentElement;
    const { dispW, dispH } = videoDisplayRect();
    if (!dispW || !dispH) return null;

    const contW = container.clientWidth;
    const contH = container.clientHeight;
    const s = zoom.scale;

    // Inverse of the transform: container point -> display offset on the canvas
    const toU = (px) => dispW / 2 + (px - contW / 2 - zoom.tx) / s;
    const toV = (py) => dispH / 2 + (py - contH / 2 - zoom.ty) / s;

    // Region to export, in container coords: the crop box when it's active,
    // otherwise the whole visible container.
    const rL = crop.active ? crop.x : 0;
    const rT = crop.active ? crop.y : 0;
    const rR = crop.active ? crop.x + crop.w : contW;
    const rB = crop.active ? crop.y + crop.h : contH;

    const u0 = Math.max(0, Math.min(dispW, toU(rL)));
    const u1 = Math.max(0, Math.min(dispW, toU(rR)));
    const v0 = Math.max(0, Math.min(dispH, toV(rT)));
    const v1 = Math.max(0, Math.min(dispH, toV(rB)));

    const kx = srcW / dispW;
    const ky = srcH / dispH;
    const sx = u0 * kx;
    const sy = v0 * ky;
    const sw = (u1 - u0) * kx;
    const sh = (v1 - v0) * ky;
    if (sw < 1 || sh < 1) return null;
    return { sx, sy, sw, sh };
}

function setupPreviewZoom() {
    const container = el.previewCanvas.parentElement; // .canvas-container

    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let panStartX = 0, panStartY = 0;
    let panStartTx = 0, panStartTy = 0;
    let moved = false;
    let lastTapTime = 0;
    let tapTimer = null;
    const DOUBLE_TAP_MS = 250;

    const touchDist = (touches) =>
        Math.hypot(
            touches[0].clientX - touches[1].clientX,
            touches[0].clientY - touches[1].clientY,
        );

    container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            cancelCropDrag(); // two fingers = pinch, not a crop drag
            pinchStartDist = touchDist(e.touches);
            pinchStartScale = zoom.scale;
            moved = true; // a pinch is never a tap
            e.preventDefault();
        } else if (e.touches.length === 1) {
            // A single finger on the crop box/handles is a crop gesture
            if (isCropTarget(e.target)) return;
            const t = e.touches[0];
            panStartX = t.clientX;
            panStartY = t.clientY;
            panStartTx = zoom.tx;
            panStartTy = zoom.ty;
            moved = false;
            // Double-tap: zoom 2x at the tapped point, or back to 1x if already zoomed
            if (e.timeStamp - lastTapTime < DOUBLE_TAP_MS) {
                if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; } // cancel pending play toggle
                if (zoom.scale > 1.01) {
                    resetZoom();
                } else {
                    zoomToPoint(t.clientX, t.clientY, 2);
                }
                zoom.suppressClick = true;
                moved = true;
                lastTapTime = 0;
            } else {
                lastTapTime = e.timeStamp;
            }
        }
    }, { passive: false });

    container.addEventListener('touchmove', (e) => {
        // Let the crop logic own single-finger drags that started on the box
        if (e.touches.length === 1 && isCropTarget(e.target)) return;
        if (e.touches.length === 2 && pinchStartDist > 0) {
            const factor = touchDist(e.touches) / pinchStartDist;
            zoom.scale = Math.max(zoom.minScale, Math.min(zoom.maxScale, pinchStartScale * factor));
            clampZoomPan();
            applyZoomTransform();
            e.preventDefault();
        } else if (e.touches.length === 1 && zoom.scale > 1) {
            const t = e.touches[0];
            const dx = t.clientX - panStartX;
            const dy = t.clientY - panStartY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
            zoom.tx = panStartTx + dx;
            zoom.ty = panStartTy + dy;
            clampZoomPan();
            applyZoomTransform();
            e.preventDefault();
        }
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
        if (e.touches.length >= 1) {
            // Lifted one finger of a pinch — re-anchor the pan so it doesn't jump
            const t = e.touches[0];
            panStartX = t.clientX;
            panStartY = t.clientY;
            panStartTx = zoom.tx;
            panStartTy = zoom.ty;
            pinchStartDist = 0;
            return;
        }

        // All fingers up
        pinchStartDist = 0;
        zoom.suppressClick = true; // tap-to-play is handled here, not via the native click

        // A crop-box gesture must never toggle play
        if (isCropTarget(e.target)) return;

        if (moved) return; // pan / pinch / double-tap — never toggles play

        // Clean single tap: wait briefly so a following tap can win as a double-tap
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
            tapTimer = null;
            if (state.mediaType) togglePlayPause();
        }, DOUBLE_TAP_MS + 40);
    });

    // --- Desktop: wheel to zoom toward the cursor, drag to pan ---
    container.addEventListener('wheel', (e) => {
        if (!state.mediaType) return;
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0015); // smooth multiplicative zoom
        zoomToPoint(e.clientX, e.clientY, zoom.scale * factor);
    }, { passive: false });

    let mouseDown = false;
    let mStartX = 0, mStartY = 0, mStartTx = 0, mStartTy = 0, mMoved = false;

    container.addEventListener('mousedown', (e) => {
        if (zoom.scale <= 1) return; // only pan when zoomed in
        if (isCropTarget(e.target)) return; // crop box drag is handled separately
        mouseDown = true;
        mMoved = false;
        mStartX = e.clientX;
        mStartY = e.clientY;
        mStartTx = zoom.tx;
        mStartTy = zoom.ty;
    });

    window.addEventListener('mousemove', (e) => {
        if (!mouseDown) return;
        const dx = e.clientX - mStartX;
        const dy = e.clientY - mStartY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) mMoved = true;
        zoom.tx = mStartTx + dx;
        zoom.ty = mStartTy + dy;
        clampZoomPan();
        applyZoomTransform();
    });

    window.addEventListener('mouseup', () => {
        if (!mouseDown) return;
        if (mMoved) zoom.suppressClick = true; // don't toggle play after a drag-pan
        mouseDown = false;
    });
}

// Fire up
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

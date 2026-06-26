import { parseGIF, decompressFrames } from 'https://esm.sh/gifuct-js@2.1.2';

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
    sourceVideo: document.getElementById('source-video'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingMessage: document.getElementById('loading-message'),
    
    // Scrubber & Playback
    timelineThumbnails: document.getElementById('timeline-thumbnails'),
    timelineScrubber: document.getElementById('timeline-scrubber'),
    timelinePlayhead: document.getElementById('timeline-playhead'),
    currentTime: document.getElementById('current-time'),
    totalTime: document.getElementById('total-time'),
    btnPrevFrame: document.getElementById('btn-prev-frame'),
    btnPlayPause: document.getElementById('btn-play-pause'),
    btnNextFrame: document.getElementById('btn-next-frame'),
    playIcon: document.getElementById('play-icon'),
    pauseIcon: document.getElementById('pause-icon'),
    frameCounter: document.getElementById('frame-counter'),
    
    // Info Panel
    btnBackHeader: document.getElementById('btn-back-header'),
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
    
    // Toast
    toast: document.getElementById('toast'),
    toastMessage: document.getElementById('toast-message')
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
    
    // Play / Pause
    el.btnPlayPause.addEventListener('click', togglePlayPause);
    
    // Next / Prev Frame Buttons
    el.btnPrevFrame.addEventListener('click', () => stepFrame(-1));
    el.btnNextFrame.addEventListener('click', () => stepFrame(1));
    
    // Scrubber Change
    el.timelineScrubber.addEventListener('input', handleScrub);
    
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
    
    // Preview Canvas click (Tap video to open high-res frame in new tab)
    el.previewCanvas.addEventListener('click', () => extractCurrentFrame(true));
    
    // Extract Button (Save)
    el.btnExtract.addEventListener('click', () => extractCurrentFrame(false));
    
    // Keyboard Hotkeys
    window.addEventListener('keydown', handleGlobalKeydowns);
}

// --- File Handling Logic ---
function handleFile(file) {
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
    
    el.sourceVideo.src = videoUrl;
    el.sourceVideo.load();
    
    // Wait for video metadata to load
    el.sourceVideo.onloadedmetadata = async () => {
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
        
        // Render first frame
        el.sourceVideo.currentTime = 0;
        await waitForSeek();
        drawVideoFrameToCanvas();
        updateTimelinePlayhead(0);
        updateFrameCounter();
        
        // Generate beautiful timeline thumbnails asynchronously
        generateVideoThumbnails(videoUrl);
        hideLoader();
    };
    
    el.sourceVideo.onerror = () => {
        hideLoader();
        alert('비디오를 로드하는 도중 오류가 발생했습니다. 브라우저에서 인코딩을 지원하지 않는 코덱일 수 있습니다.');
    };
}

// Wait for video seek to complete
function waitForSeek() {
    return new Promise(resolve => {
        const onSeeked = () => {
            el.sourceVideo.removeEventListener('seeked', onSeeked);
            resolve();
        };
        el.sourceVideo.addEventListener('seeked', onSeeked);
    });
}

// Draw current video frame to display canvas
function drawVideoFrameToCanvas() {
    ctx.clearRect(0, 0, el.previewCanvas.width, el.previewCanvas.height);
    ctx.drawImage(el.sourceVideo, 0, 0, el.previewCanvas.width, el.previewCanvas.height);
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
        
        // Render first frame
        drawGIFFrame(0);
        updateTimelinePlayhead(0);
        updateFrameCounter();
        
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
    ctx.clearRect(0, 0, el.previewCanvas.width, el.previewCanvas.height);
    ctx.drawImage(state.gifFrames[index], 0, 0);
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
    
    el.playIcon.style.display = 'none';
    el.pauseIcon.style.display = 'block';
    
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
    
    el.playIcon.style.display = 'block';
    el.pauseIcon.style.display = 'none';
    
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

// Scrubber handle dragging (timeline sliding)
async function handleScrub(e) {
    pause();
    const val = parseInt(e.target.value);
    const pct = val / 1000;
    
    if (state.mediaType === 'video') {
        const seekTime = pct * state.duration;
        el.sourceVideo.currentTime = seekTime;
        await waitForSeek();
        drawVideoFrameToCanvas();
        
        state.currentFrameIndex = Math.min(state.totalFrames - 1, Math.floor(seekTime * state.fps));
        el.currentTime.textContent = formatTime(seekTime);
        updateTimelinePlayhead(pct, false); // don't move range value again since user is dragging it
        updateFrameCounter();
        
    } else if (state.mediaType === 'gif') {
        const targetFrameIdx = Math.min(state.totalFrames - 1, Math.floor(pct * state.totalFrames));
        state.currentFrameIndex = targetFrameIdx;
        drawGIFFrame(targetFrameIdx);
        
        const curTime = state.gifAccumulatedTimes[targetFrameIdx];
        el.currentTime.textContent = formatTime(curTime);
        updateTimelinePlayhead(pct, false);
        updateFrameCounter();
    }
}

// --- Auxiliary UI Sync Helpers ---
function updateTimelinePlayhead(pct, updateSlider = true) {
    const playheadPct = pct * 100;
    el.timelinePlayhead.style.left = `${playheadPct}%`;
    if (updateSlider) {
        el.timelineScrubber.value = Math.round(pct * 1000);
    }
}

function updateFrameCounter() {
    el.frameCounter.textContent = `프레임: ${state.currentFrameIndex + 1} / ${state.totalFrames}`;
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
    
    // Reset state
    state.mediaType = null;
    state.fileName = '';
    state.duration = 0;
    state.totalFrames = 0;
    state.currentFrameIndex = 0;
}

// --- 5. High-Resolution Frame Extraction & Exporting ---
function extractCurrentFrame(forceNewTab = false) {
    showLoader('고화질 프레임 캡처 중...');
    
    // Create temporary full-resolution export canvas
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = state.videoWidth;
    exportCanvas.height = state.videoHeight;
    const eCtx = exportCanvas.getContext('2d');
    
    if (state.mediaType === 'video') {
        // Draw the current video frame at native camera capture resolution
        eCtx.drawImage(el.sourceVideo, 0, 0, state.videoWidth, state.videoHeight);
    } else if (state.mediaType === 'gif') {
        // Draw the cached full-resolution frame ImageBitmap
        const bitmap = state.gifFrames[state.currentFrameIndex];
        if (bitmap) {
            eCtx.drawImage(bitmap, 0, 0);
        }
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
    
    // Export and trigger download/preview
    exportCanvas.toBlob((blob) => {
        hideLoader();
        if (!blob) {
            alert('이미지 추출에 실패했습니다.');
            return;
        }
        
        if (!forceNewTab) {
            // Always download/save directly when clicking "저장" button
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            
            // Clean suffix with frame index or timestamp
            const baseName = state.fileName.substring(0, state.fileName.lastIndexOf('.')) || 'CapShot';
            const suffix = `_frame_${state.currentFrameIndex + 1}`;
            a.download = `${baseName}${suffix}.${ext}`;
            
            a.href = url;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            // Trigger beautiful Toast Notification
            showToast(`프레임 ${state.currentFrameIndex + 1}이 고화질 ${state.exportFormat.toUpperCase()} 파일로 저장되었습니다!`);
        } else {
            // Open in new tab/window when tapping the top video preview canvas
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
        }
    }, mimeType, state.exportFormat === 'png' ? undefined : state.exportQuality);
}

// Show animated success toast notification
function showToast(message) {
    el.toastMessage.textContent = message;
    el.toast.classList.add('show');
    
    setTimeout(() => {
        el.toast.classList.remove('show');
    }, 4000);
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

// Fire up
document.addEventListener('DOMContentLoaded', init);
init(); // fallback

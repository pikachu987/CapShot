// ============================================================
//  CapShot Service Worker
//  ★ 코드/리소스를 업데이트했으면 아래 APP_VERSION 값을 올리세요.
//    (예: 'v1.0.0' → 'v1.0.1')
//    버전이 바뀌면 기존 캐시를 모두 지우고 새 리소스로 자동 갱신됩니다.
// ============================================================
const APP_VERSION = 'v1.0.0';
const CACHE_NAME = `capshot-${APP_VERSION}`;

// 오프라인 지원을 위해 미리 캐싱할 리소스 (버전 쿼리는 무시하고 매칭)
const PRECACHE_URLS = [
    './',
    './index.html',
    './app.css',
    './app.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
];

// 런타임 캐싱 대상 (구글 폰트) — 완전 오프라인용
const FONT_ORIGINS = [
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const isSameOrigin = url.origin === self.location.origin;
    const isFont = FONT_ORIGINS.includes(url.origin);

    // 페이지 이동(주소창/새로고침): 캐시된 index.html 우선, 없으면 네트워크
    if (request.mode === 'navigate') {
        event.respondWith(
            caches.match('./index.html', { ignoreSearch: true })
                .then((cached) => cached || fetch(request))
        );
        return;
    }

    // 앱 리소스 + 폰트: 캐시 우선, 없으면 네트워크로 받아 캐시에 저장
    if (isSameOrigin || isFont) {
        event.respondWith(
            caches.match(request, { ignoreSearch: true }).then((cached) => {
                if (cached) return cached;
                return fetch(request).then((response) => {
                    if (response && (response.ok || response.type === 'opaque')) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                }).catch(() => cached);
            })
        );
    }
    // 그 외(외부 영상 등)는 기본 네트워크 처리
});

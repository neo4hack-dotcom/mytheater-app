// MyTheater — service worker : app disponible hors connexion, jaquettes en cache, jeton Google ajouté aux flux vidéo.
const SHELL = 'mytheater-shell-v2';
const IMAGES = 'mytheater-images';
const BASE = new URL('./', self.location).pathname;

// Coquille hors ligne : la page et les fichiers versionnés qu'elle charge (lus dans index.html, car le premier
// chargement se fait avant que le service worker ne contrôle la page)
async function precache() {
    const c = await caches.open(SHELL);
    const page = await fetch(BASE, { cache: 'no-cache' });
    const html = await page.clone().text();
    await c.put(BASE, page);
    const assets = [...new Set([...html.matchAll(/["'](?:\.\/)?(assets\/[^"']+)["']/g)].map((m) => BASE + m[1]))];
    await c.addAll([...assets, BASE + 'manifest.webmanifest', BASE + 'icon-192.png', BASE + 'apple-touch-icon.png']);
}

self.addEventListener('install', (event) => {
    event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mytheater-shell') && k !== SHELL).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

/** Jetons Google rangés par l'app dans IndexedDB (le service worker n'a pas accès au localStorage). */
function readTokens() {
    return new Promise((resolve) => {
        const open = indexedDB.open('mytheater', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => resolve({});
        open.onsuccess = () => {
            const req = open.result.transaction('kv').objectStore('kv').get('google_tokens');
            req.onsuccess = () => resolve(req.result || {});
            req.onerror = () => resolve({});
        };
    });
}

/**
 * Flux Drive lus directement par <video> (MP4, MOV) : la balise vidéo ne peut pas envoyer d'en-tête
 * Authorization, le service worker l'ajoute à chaque requête Range. Adresse : <app>/__stream/<compte>/<fichier>
 */
async function streamDrive(request, email, fileId) {
    const tokens = await readTokens();
    const token = tokens[email];
    if (!token || token.expiresAt < Date.now()) return new Response('Connexion Google expirée', { status: 401 });
    const headers = { Authorization: `Bearer ${token.token}` };
    const range = request.headers.get('Range');
    if (range) headers.Range = range;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers });
    const out = new Headers();
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
        const v = res.headers.get(h);
        if (v) out.set(h, v);
    }
    if (!out.has('Accept-Ranges')) out.set('Accept-Ranges', 'bytes');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET') return;

    if (url.origin === self.location.origin && url.pathname.startsWith(BASE + '__stream/')) {
        const [email, fileId] = url.pathname.slice((BASE + '__stream/').length).split('/').map(decodeURIComponent);
        event.respondWith(streamDrive(req, email, fileId));
        return;
    }

    // Jaquettes TMDB : en cache dès le premier affichage, pour la bibliothèque hors connexion
    if (url.hostname === 'image.tmdb.org') {
        event.respondWith(
            caches.open(IMAGES).then((c) =>
                c.match(req).then(
                    (hit) =>
                        hit ||
                        fetch(req).then((res) => {
                            c.put(req, res.clone());
                            return res;
                        })
                )
            )
        );
        return;
    }

    if (url.origin !== self.location.origin) return;
    // Fichiers versionnés de /assets : cache d'abord. Pages : réseau d'abord, cache en secours.
    if (url.pathname.startsWith(BASE + 'assets/')) {
        event.respondWith(
            caches.match(req).then(
                (hit) =>
                    hit ||
                    fetch(req).then((res) => {
                        const copy = res.clone();
                        caches.open(SHELL).then((c) => c.put(req, copy));
                        return res;
                    })
            )
        );
        return;
    }
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(SHELL).then((c) => c.put(BASE, copy));
                    return res;
                })
                .catch(() => caches.match(BASE))
        );
    }
});

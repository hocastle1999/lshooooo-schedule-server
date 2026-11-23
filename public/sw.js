// sw.js — 방송 알림(웹 푸시)을 받아서 띄우는 서비스 워커.
// 사이트를 닫아 둬도 브라우저가 이 파일로 알림을 띄운다. 알림을 누르면 url(방송 화면이나 작업실)을 연다.

self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch(err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '이상호 매니저 작업실', {
    body: d.body || '',
    icon: '/icons/icon-schedule.png',
    badge: '/icons/icon-schedule.png',
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
    // 작업실로 가는 알림이면 이미 열린 작업실 창을 앞으로
    if (url === '/') {
      for (var i = 0; i < list.length; i++) {
        if (new URL(list[i].url).pathname === '/' && 'focus' in list[i]) return list[i].focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});

// ==UserScript==
// @name         게임닷 원신 맵스 실시간 위치
// @namespace    gamedot-map-paisitioning-compat
// @version      0.3.0
// @description  Haytsir의 원신 파이지셔닝 앱 v1.2.2와 새 게임닷 티바트 지도를 연결합니다.
// @match        https://gamedot.org/genshin/map/*
// @run-at       document-start
// @homepageURL  https://github.com/bingsu-alpa/Genshin-Paisitioning-App-pacuri
// @downloadURL  https://raw.githubusercontent.com/bingsu-alpa/Genshin-Paisitioning-App-pacuri/main/gamedot-paisitioning.user.js
// @updateURL    https://raw.githubusercontent.com/bingsu-alpa/Genshin-Paisitioning-App-pacuri/main/gamedot-paisitioning.user.js
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(() => {
  'use strict';

  const page = unsafeWindow;
  const route = '/genshin/map/teyvat';
  const origin = [10204, 19139]; // GameDot Teyvat relativeY, relativeX
  let map, marker, arrow, view, panel, status, connect, stop, follow;
  let socket, session, position, renderedPosition;
  let lastUpdate = 0;
  let frame = null;
  let heading = null;
  let cameraHeading = null;

  function show(message) {
    if (status && status.textContent !== message) status.textContent = message;
  }

  function currentMap() {
    if (location.pathname.replace(/\/$/, '') !== route) return null;
    const container = document.querySelector('.leaflet-container[role="region"]');
    if (!container) return null;
    if (map?.getContainer() === container) return map;

    // The React map component stores its Leaflet instance in a useRef hook.
    const fiberKey = Object.getOwnPropertyNames(container)
      .find(key => key.startsWith('__reactFiber$'));
    for (let fiber = container[fiberKey]; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const candidate = hook.memoizedState?.current;
        if (typeof candidate?.getContainer === 'function' && candidate.getContainer() === container &&
            typeof candidate.setView === 'function' && candidate._loaded) {
          return candidate;
        }
      }
    }
    return null;
  }

  function clearMarker() {
    marker?.remove();
    marker = arrow = view = null;
    renderedPosition = null;
  }

  function scheduleRender() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      render();
    });
  }

  function render() {
    if (!panel) return;
    const nextMap = currentMap();
    if (nextMap !== map) {
      clearMarker();
      map = nextMap;
    }
    panel.hidden = location.pathname.replace(/\/$/, '') !== route;
    // Stationary characters may stop producing valid position samples.
    // Retain the last position until the connection closes or the map changes.
    if (!position) return;
    if (!map || !page.L?.divIcon) {
      show('게임닷 지도가 로드되기를 기다리는 중');
      return;
    }
    if (!marker) {
      const icon = page.L.divIcon({
        className: 'gamedot-gps-arrow',
        iconSize: [64, 64],
        iconAnchor: [32, 32],
        html: `<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"
          style="overflow:visible;filter:drop-shadow(0 1px 3px #071e30);pointer-events:none">
          <path data-view d="M32 32 16 8 Q32 -1 48 8Z"
            fill="#83efff" fill-opacity=".38" stroke="#d4faff" stroke-width="1"/>
          <path data-arrow d="M32 16 44 44 32 38 20 44Z" stroke="#fff" stroke-width="2.5"
            stroke-linejoin="round" fill="#00b8e4"/>
          <circle data-no-heading cx="32" cy="32" r="7" fill="#00b8e4" stroke="#fff" stroke-width="2.5"/>
        </svg>`,
      });
      marker = page.L.marker(position, {
        icon, interactive: false, keyboard: false, zIndexOffset: 1500,
      }).addTo(map);
      arrow = marker.getElement().querySelector('[data-arrow]');
      view = marker.getElement().querySelector('[data-view]');
    }
    arrow.setAttribute('visibility', heading === null ? 'hidden' : 'visible');
    arrow.nextElementSibling.setAttribute('visibility', heading === null ? 'visible' : 'hidden');
    view.setAttribute('visibility', cameraHeading === null ? 'hidden' : 'visible');
    if (heading !== null) arrow.setAttribute('transform', `rotate(${heading} 32 32)`);
    if (cameraHeading !== null) view.setAttribute('transform', `rotate(${cameraHeading} 32 32)`);

    const moved = !renderedPosition || position.some((value, index) => value !== renderedPosition[index]);
    if (moved) {
      marker.setLatLng(position);
      if (follow.checked) map.panTo(position, { animate: false });
      renderedPosition = position;
    }
    show(Date.now() - lastUpdate > 4000
      ? '연결 유지 중 · 마지막 확인 위치 표시'
      : '티바트 위치 추적 중');
  }

  function register() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'http://localhost:32332/register',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ user_id: 1 }),
        timeout: 2000,
        onload(response) {
          try {
            if (response.status < 200 || response.status >= 300) throw Error('등록 실패');
            const url = new URL(JSON.parse(response.responseText).url);
            if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1'].includes(url.hostname) ||
                url.port !== '32332' || !url.pathname.startsWith('/ws/') ||
                url.username || url.password) throw Error('등록 주소 오류');
            resolve(url.href);
          } catch (error) {
            reject(error);
          }
        },
        onerror: reject,
        ontimeout: reject,
        onabort: reject,
      });
    });
  }

  function disconnect(message = '연결 종료') {
    session = null;
    const oldSocket = socket;
    socket = null;
    oldSocket?.close();
    position = null;
    heading = cameraHeading = null;
    clearMarker();
    connect.disabled = false;
    stop.disabled = true;
    show(message);
  }

  function handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.event === 'init' || message?.event === 'doneInit') {
      show('연결됨 · 미니맵 위치 신호 대기 중');
      return;
    }
    if (message?.event !== 'track' || !message.data) return;
    const { m, x, y, a, r, err } = message.data;
    if (m != null && m !== 0) {
      position = null;
      heading = cameraHeading = null;
      clearMarker();
      show('티바트 지상 지도에서 추적할 수 있습니다');
      return;
    }
    let trackingError = err;
    if (typeof err === 'string' && err) {
      try {
        trackingError = JSON.parse(err);
      } catch {
        return;
      }
    }
    if (m !== 0 || trackingError?.errorList?.length ||
        !Number.isFinite(x) || !Number.isFinite(y) ||
        (x === 0 && y === 0)) return;
    // Apply the original v1.7.3 Teyvat conversion, then GameDot's new tile origin.
    position = [origin[0] + (y + 5890) / 2, origin[1] + (x - 2285) / 2];
    // The app reports character and camera angles counterclockwise from north.
    if (Number.isFinite(a)) heading = -a;
    if (Number.isFinite(r)) cameraHeading = -r;
    lastUpdate = Date.now();
    scheduleRender();
  }

  async function start(launch) {
    const attempt = {};
    session = attempt;
    connect.disabled = true;
    stop.disabled = false;
    show('파이지셔닝 앱 연결 중');
    if (launch) {
      const link = document.createElement('a');
      link.href = 'genshin-paisitioning://launch';
      link.click();
    }

    let endpoint;
    for (let retry = 0; retry < 10 && session === attempt; retry++) {
      try {
        endpoint = await register();
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    if (session !== attempt) return;
    if (!endpoint) {
      disconnect('앱 응답 없음 · EXE를 직접 실행한 후 다시 연결해 주세요');
      return;
    }

    try {
      const connection = new WebSocket(endpoint);
      socket = connection;
      const timeout = setTimeout(() => {
        if (socket === connection && connection.readyState === WebSocket.CONNECTING) {
          disconnect('WebSocket 연결 시간 초과');
        }
      }, 8000);
      connection.addEventListener('open', () => {
        clearTimeout(timeout);
        if (socket !== connection) return;
        connection.send(JSON.stringify({ event: 'init', data: null }));
        show('연결됨 · 추적 초기화 중');
      });
      connection.addEventListener('message', event => {
        if (socket === connection) handleMessage(event);
      });
      connection.addEventListener('close', () => {
        clearTimeout(timeout);
        if (socket === connection) disconnect('앱 연결이 끊겼습니다');
      });
      connection.addEventListener('error', () => {
        clearTimeout(timeout);
        if (socket === connection) disconnect('WebSocket 연결 실패 · 로컬 연결 권한을 확인해 주세요');
      });
    } catch {
      disconnect('브라우저가 로컬 WebSocket 연결을 열지 못했습니다');
    }
  }

  function mount() {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { position: fixed; right: 16px; bottom: 80px; z-index: 10000; }
        section { width: 225px; padding: 12px; border: 1px solid #52617a;
          border-radius: 12px; color: #f5f7fb; background: #172234;
          font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 6px 24px #0004; }
        strong, label, output { display: block; margin-bottom: 8px; }
        button { margin: 0 3px 8px 0; padding: 5px 7px; cursor: pointer; }
        button:disabled { cursor: default; }
        output { margin: 0; overflow-wrap: anywhere; }
      </style>
      <section hidden aria-label="원신 위치 추적">
        <strong>원신 위치 추적</strong>
        <button id="connect" type="button">앱 실행 · 연결</button>
        <button id="stop" type="button" disabled>연결 해제</button>
        <label><input type="checkbox" checked> 캐릭터 따라가기</label>
        <output aria-live="polite">연결 대기</output>
      </section>`;
    panel = root.querySelector('section');
    status = root.querySelector('output');
    connect = root.querySelector('#connect');
    stop = root.querySelector('#stop');
    follow = root.querySelector('input');
    connect.addEventListener('click', () => start(true));
    stop.addEventListener('click', () => disconnect());
    follow.addEventListener('change', () => {
      renderedPosition = null;
      scheduleRender();
    });
    document.body.append(host);
    render();
    // Low-frequency maintenance handles SPA navigation and sample age.
    // Position and direction updates render on the next animation frame.
    setInterval(render, 1000);
    document.addEventListener('visibilitychange', scheduleRender);
    window.addEventListener('pagehide', () => disconnect());
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();

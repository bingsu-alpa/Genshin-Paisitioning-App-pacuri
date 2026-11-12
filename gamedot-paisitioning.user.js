// ==UserScript==
// @name         게임닷 원신 맵스 실시간 위치
// @namespace    gamedot-map-paisitioning-compat
// @version      0.1.0
// @description  Haytsir의 원신 파이지셔닝 앱 v1.2.2와 새 게임닷 티바트 지도를 연결합니다.
// @match        https://gamedot.org/genshin/map/*
// @run-at       document-start
// @homepageURL  https://github.com/fairy1598-maker/Genshin-Paisitioning-App-pacuri
// @downloadURL  https://raw.githubusercontent.com/fairy1598-maker/Genshin-Paisitioning-App-pacuri/main/gamedot-paisitioning.user.js
// @updateURL    https://raw.githubusercontent.com/fairy1598-maker/Genshin-Paisitioning-App-pacuri/main/gamedot-paisitioning.user.js
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
  let map, marker, panel, status, connect, stop, follow;
  let socket, session, position, renderedPosition;
  let lastUpdate = 0;

  function show(message) {
    if (status) status.textContent = message;
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
    marker = null;
    renderedPosition = null;
  }

  function render() {
    if (!panel) return;
    const nextMap = currentMap();
    if (nextMap !== map) {
      clearMarker();
      map = nextMap;
    }
    panel.hidden = location.pathname.replace(/\/$/, '') !== route;
    if (!position || Date.now() - lastUpdate > 4000) {
      if (position) show('미니맵 위치 신호를 기다리는 중');
      position = null;
      clearMarker();
      return;
    }
    if (!map || !page.L?.circleMarker) {
      show('게임닷 지도가 로드되기를 기다리는 중');
      return;
    }
    if (position === renderedPosition) return;
    if (!marker) {
      marker = page.L.circleMarker(position, {
        radius: 8, color: '#fff', weight: 3, fillColor: '#287bff',
        fillOpacity: 1, interactive: false, pane: 'markerPane',
      }).addTo(map);
    } else {
      marker.setLatLng(position);
    }
    if (follow.checked) map.panTo(position, { animate: false });
    renderedPosition = position;
    show('티바트 위치 추적 중');
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
    const { m, x, y, err } = message.data;
    if (m != null && m !== 0) {
      position = null;
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
    lastUpdate = Date.now();
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
    follow.addEventListener('change', () => { renderedPosition = null; });
    document.body.append(host);
    render();
    setInterval(render, 150);
    window.addEventListener('pagehide', () => disconnect());
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();

/**
 * SINVoice — оверлей: участники звонка и кто сейчас говорит.
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

(() => {
  const list = document.querySelector('[data-sv="list"]');
  const NS = 'http://www.w3.org/2000/svg';
  const MIC_OFF = 'M19 11h-2a5 5 0 0 1-.7 2.56l1.46 1.46A6.96 6.96 0 0 0 19 11zM15 11V5a3 3 0 0 0-5.94-.6L15 10.34V11zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.38 2.65l1.52 1.52A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 3.32-1.33L19.73 20 21 18.73 4.27 3z';

  /**
   * Иконка выключенного микрофона.
   * @returns {SVGElement}
   */
  function mutedIcon() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'sv-overlay__muted');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', MIC_OFF);
    svg.appendChild(path);
    return svg;
  }

  /**
   * Перерисовывает список участников.
   * @param {{id:number, nick:string, avatar:string, muted:boolean, color:string}[]} peers Участники
   */
  function render(peers) {
    list.textContent = '';
    for (const p of peers) {
      const li = document.createElement('li');
      li.className = 'sv-overlay__row';
      li.dataset.id = String(p.id);
      const av = document.createElement('div');
      av.className = 'sv-overlay__avatar';
      if (typeof p.avatar === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(p.avatar)) {
        const img = document.createElement('img');
        img.className = 'sv-overlay__image';
        img.src = p.avatar;
        img.alt = '';
        av.appendChild(img);
      } else {
        av.textContent = Array.from(String(p.nick || '?'))[0];
        if (/^hsl\(\d+ \d+% \d+%\)$/.test(p.color)) av.style.setProperty('background-color', p.color);
      }
      const nick = document.createElement('span');
      nick.className = 'sv-overlay__nick';
      nick.textContent = String(p.nick || '');
      li.append(av, nick);
      if (p.muted) {
        li.appendChild(mutedIcon());
      } else {
        const eq = document.createElement('span');
        eq.className = 'sv-overlay__eq';
        for (let i = 0; i < 4; i++) {
          const bar = document.createElement('i');
          bar.className = 'sv-overlay__eq-bar';
          eq.appendChild(bar);
        }
        li.appendChild(eq);
      }
      list.appendChild(li);
    }
  }

  /**
   * Подсвечивает говорящих.
   * @param {number[]} ids Id говорящих
   */
  function speaking(ids) {
    for (const li of list.children) {
      li.classList.toggle('sv-overlay__row_speaking', ids.includes(Number(li.dataset.id)));
    }
  }

  window.sinvoice.onOverlayPeers(render);
  window.sinvoice.onOverlaySpeaking(speaking);
})();

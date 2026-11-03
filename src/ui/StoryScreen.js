/** End poem/credits plus advancement and statistics surfaces. */

import { button, el, setVisible } from './dom.js';

const END_POEM = Object.freeze([
  'You crossed forests, caves, oceans, and fire.',
  'You carried the first piece of wood farther than it knew it could go.',
  'The world answered every block you placed with another horizon.',
  'In the dark between islands, you made your own road.',
  'The dragon fell. The portal opened. The world remained.',
  'There are still homes to build, maps to fill, and skies to fly.',
  'Wake now, traveller. Your story is yours to continue.',
]);

function formatNumber(value, digits = 0) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits:digits });
}

export class StoryScreen {
  constructor({ root, onClose, onCreditsFinished } = {}) {
    this.onClose = onClose;
    this.onCreditsFinished = onCreditsFinished;
    this.title = el('h1', { className:'story-title', text:'The End' });
    this.subtitle = el('p', { className:'dialog-subtitle' });
    this.content = el('div', { className:'story-content' });
    this.closeButton = button('Return to the world', () => {
      if (this.mode === 'credits') this.onCreditsFinished?.();
      this.onClose?.();
    }, { className:'ui-button--primary ui-button--wide' });
    this.element = el('div', {
      className:'screen screen--dim story-screen', hidden:true,
      attrs:{ role:'dialog', 'aria-modal':'true', 'aria-label':'Progress and credits' },
    }, [el('div', { className:'panel story-panel' }, [
      this.title, this.subtitle, this.content,
      el('div', { className:'dialog-actions' }, [this.closeButton]),
    ])]);
    root.appendChild(this.element);
    this.mode = 'progress';
  }

  showCredits(snapshot = {}) {
    this.mode = 'credits';
    this.title.textContent = 'The End';
    this.subtitle.textContent = 'Free the End';
    const poem = el('div', { className:'end-poem' }, END_POEM.map((line) => el('p', { text:line })));
    const credits = el('div', { className:'end-credits' }, [
      el('h2', { text:'TITANCRAFT' }),
      el('p', { text:'Design, engineering, worlds, creatures, music systems, and testing' }),
      el('p', { text:'Built as an original Three.js voxel adventure' }),
      el('p', { text:`Dragon victories: ${formatNumber(snapshot?.counters?.dragonsDefeated)}` }),
      el('p', { text:`Time played: ${formatNumber((snapshot?.counters?.timePlayed || 0) / 3600, 1)} hours` }),
      el('p', { text:'Thank you for playing.' }),
    ]);
    this.content.replaceChildren(poem, credits);
    this.content.scrollTop = 0;
    this.closeButton.textContent = 'Return to the Overworld';
    setVisible(this.element, true);
    requestAnimationFrame(() => this.closeButton.focus({ preventScroll:true }));
  }

  showProgress(snapshot = {}) {
    this.mode = 'progress';
    this.title.textContent = 'World Progress';
    const unlocked = (snapshot.advancements ?? []).filter((entry) => entry.unlocked).length;
    this.subtitle.textContent = `${unlocked}/${snapshot.advancements?.length ?? 0} advancements`;
    const counters = snapshot.counters ?? {};
    const grid = el('div', { className:'statistics-grid' }, [
      ['Time played', `${formatNumber((counters.timePlayed || 0) / 3600, 1)} h`],
      ['Blocks mined', formatNumber(counters.blocksMined)],
      ['Blocks placed', formatNumber(counters.blocksPlaced)],
      ['Items crafted', formatNumber(counters.itemsCrafted)],
      ['Mobs defeated', formatNumber(counters.mobsKilled)],
      ['Deaths', formatNumber(counters.deaths)],
      ['Distance walked', `${formatNumber(counters.distanceWalked, 1)} m`],
      ['Distance flown', `${formatNumber(counters.distanceFlown, 1)} m`],
      ['Portals used', formatNumber(counters.portalsUsed)],
      ['Dragons defeated', formatNumber(counters.dragonsDefeated)],
    ].map(([label,value]) => el('div', { className:'statistic-card' }, [
      el('span', { text:label }), el('strong', { text:value }),
    ])));
    const tree = el('div', { className:'advancement-tree' }, (snapshot.advancements ?? []).map((entry) =>
      el('div', { className:`advancement ${entry.unlocked ? 'is-unlocked' : ''}` }, [
        el('span', { className:'advancement-state', text:entry.unlocked ? '✓' : '◇' }),
        el('div', {}, [el('strong', { text:entry.title }), el('small', { text:entry.trigger })]),
      ])
    ));
    const markers = el('div', { className:'death-marker-list' }, (snapshot.deathMarkers ?? []).map((marker) =>
      el('p', { text:`${marker.dimension}: ${Math.round(marker.x)}, ${Math.round(marker.y)}, ${Math.round(marker.z)} — ${marker.cause}` })
    ));
    this.content.replaceChildren(
      el('h2', { text:'Statistics' }), grid,
      el('h2', { text:'Advancements' }), tree,
      el('h2', { text:'Death markers' }), markers,
    );
    this.closeButton.textContent = 'Back';
    setVisible(this.element, true);
    requestAnimationFrame(() => this.closeButton.focus({ preventScroll:true }));
  }

  hide() { setVisible(this.element, false); }
  destroy() { this.element.remove(); }
}

export default StoryScreen;

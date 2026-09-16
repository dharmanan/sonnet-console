let poemsCache = null;

async function loadPoems() {
  if (poemsCache) return poemsCache;

  const response = await fetch(
    '/sonnet-poems.json',
    { cache: 'no-store' }
  );

  if (!response.ok) {
    throw new Error(
      `Poem data HTTP ${response.status}`
    );
  }

  poemsCache = await response.json();
  return poemsCache;
}

function ensurePoemDialog() {
  let dialog =
    document.querySelector('#poemDialog');

  if (dialog) return dialog;

  dialog = document.createElement('dialog');
  dialog.id = 'poemDialog';
  dialog.className = 'poem-dialog';

  dialog.innerHTML = `
    <div class="poem-dialog-head">
      <div>
        <div class="eyebrow">SONNET-2 · ACCEPTED ENTRY</div>
        <h2 id="poemDialogTitle">Poem</h2>
      </div>
      <button id="closePoemDialog" class="ghost" type="button">Kapat</button>
    </div>

    <div id="poemDialogMeta" class="poem-meta"></div>
    <pre id="poemDialogText" class="poem-text"></pre>
  `;

  document.body.appendChild(dialog);

  dialog
    .querySelector('#closePoemDialog')
    .addEventListener(
      'click',
      () => dialog.close()
    );

  dialog.addEventListener(
    'click',
    event => {
      if (event.target === dialog) {
        dialog.close();
      }
    }
  );

  return dialog;
}

async function showPoem(entryId, votes) {
  try {
    const poems = await loadPoems();
    const poem = poems?.[entryId];

    if (!poem) {
      throw new Error(
        'Bu entry için şiir bulunamadı.'
      );
    }

    const dialog =
      ensurePoemDialog();

    dialog.querySelector(
      '#poemDialogTitle'
    ).textContent = entryId;

    dialog.querySelector(
      '#poemDialogMeta'
    ).textContent =
      `${Number(votes || 0).toLocaleString('tr-TR')} oy · ` +
      `final version ${poem.finalVersion ?? '—'}`;

    dialog.querySelector(
      '#poemDialogText'
    ).textContent =
      Array.isArray(poem.lines)
        ? poem.lines.join('\n')
        : '';

    dialog.showModal();
  } catch (error) {
    alert(error.message);
  }
}

const els = {
  refresh: document.querySelector('#refreshAudit'),
  status: document.querySelector('#auditStatus'),
  accepted: document.querySelector('#acceptedCount'),
  voters: document.querySelector('#voterCount'),
  window: document.querySelector('#voteWindow'),
  refreshed: document.querySelector('#refreshedAt'),
  body: document.querySelector('#auditRows'),
  note: document.querySelector('#retentionNote'),
};

async function api(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json'
    },
    cache: 'no-store'
  });

  const text =
    await response.text();

  let payload = null;

  try {
    payload =
      text
        ? JSON.parse(text)
        : {};
  } catch {}

  if (!response.ok) {
    throw new Error(
      payload?.error ||
      text ||
      `HTTP ${response.status}`
    );
  }

  return payload || {};
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fingerprint(entry) {
  const families =
    Array.isArray(entry.families)
      ? entry.families
      : [];

  if (!families.length) {
    return {
      text: '—',
      tone: 'muted'
    };
  }

  const first = families[0];
  const share =
    entry.votes > 0
      ? first.count / entry.votes
      : 0;

  if (
    first.family === 'counter-did8' &&
    share >= 0.8
  ) {
    return {
      text:
        `counter-did8 · ${first.count}`,
      tone: 'signal'
    };
  }

  if (
    first.family === 'ballot-acc' &&
    share >= 0.8
  ) {
    return {
      text:
        `ballot-acc · ${first.count}`,
      tone: 'signal'
    };
  }

  if (
    first.family === 'quire-vote' &&
    share >= 0.8
  ) {
    return {
      text:
        `quire-vote · ${first.count}`,
      tone: 'neutral'
    };
  }

  if (
    first.family === 'def-ballot' &&
    share >= 0.8
  ) {
    return {
      text:
        `def-ballot · ${first.count}`,
      tone: 'neutral'
    };
  }

  return {
    text:
      families
        .slice(0, 2)
        .map(
          x =>
            `${x.family} ${x.count}`
        )
        .join(' + '),
    tone: 'mixed'
  };
}

function render(payload) {
  const entries =
    Array.isArray(payload.entries)
      ? payload.entries
      : [];

  els.body.innerHTML =
    entries.map(
      (entry, index) => {
        const mark =
          fingerprint(entry);

        return `
          <tr>
            <td class="rank">
              ${index + 1}
            </td>

            <td>
              <strong>
                ${escapeHtml(entry.entryId)}
              </strong>

              <button
                class="poem-button"
                type="button"
                data-poem-entry="${escapeHtml(entry.entryId)}"
                data-poem-votes="${Number(entry.votes || 0)}"
              >
                Şiiri Gör
              </button>
            </td>

            <td class="votes">
              ${Number(entry.votes || 0)
                .toLocaleString('tr-TR')}
            </td>

            <td>
              <span class="accepted">
                Accepted
              </span>
            </td>

            <td>
              <span class="tag ${escapeHtml(mark.tone)}">
                ${escapeHtml(mark.text)}
              </span>
            </td>
          </tr>
        `;
      }
    ).join('');

  els.accepted.textContent =
    Number(
      payload.counts?.acceptedEntries ||
      0
    ).toLocaleString('tr-TR');

  els.voters.textContent =
    Number(
      payload.counts?.canonicalVoters ||
      0
    ).toLocaleString('tr-TR');

  const first =
    payload.retained?.firstVoteSeq;

  const last =
    payload.retained?.lastVoteSeq;

  els.window.textContent =
    first && last
      ? `${Number(first).toLocaleString('tr-TR')} → ${Number(last).toLocaleString('tr-TR')}`
      : '—';

  els.refreshed.textContent =
    new Date(
      payload.generatedAt ||
      Date.now()
    ).toLocaleTimeString(
      'tr-TR',
      {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }
    );

  els.note.textContent =
    `Oy sayıları retained public vote penceresindeki son accepted referee receipt esas alınarak hesaplanır. Okunan vote satırı: ${Number(payload.retained?.voteRows || 0).toLocaleString('tr-TR')}.`;

  for (const button of document.querySelectorAll('[data-poem-entry]')) {
    button.addEventListener(
      'click',
      () => showPoem(
        button.dataset.poemEntry,
        Number(button.dataset.poemVotes || 0)
      )
    );
  }
}

async function refreshAudit() {
  els.refresh.disabled = true;
  els.status.classList.remove(
    'error'
  );
  els.status.textContent =
    'Public export okunuyor…';

  try {
    const payload =
      await api(
        '/api/audit-snapshot'
      );

    render(payload);

    els.status.textContent =
      'Hazır · public read-only';
  } catch (error) {
    console.error(error);

    els.status.textContent =
      `Yüklenemedi: ${error.message}`;

    els.status.classList.add(
      'error'
    );
  } finally {
    els.refresh.disabled = false;
  }
}

els.refresh.addEventListener(
  'click',
  refreshAudit
);

refreshAudit();

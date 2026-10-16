// Requires Chrome/Chromium with DevTools exposed at http://127.0.0.1:9222.
const ROOT_URL = 'https://versionpublicarnpdno.segob.gob.mx/';
const SOCIO_URL = 'https://versionpublicarnpdno.segob.gob.mx/Dashboard/Sociodemografico';
const STATE_ID = '9';
const STATE_TEXT = 'CIUDAD DE MEXICO';
const METRIC_IDS = {
  total: 'TotalGlobal',
  desaparecidasNoLocalizadas: 'TotalDesaparecidosNoLocalizados',
  localizadas: 'TotalLocalizados',
  localizadasSinVida: 'TotalLocalizadosSV',
  localizadasConVida: 'TotalLocalizadosCV'
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getBrowserWsUrl() {
  const response = await fetch('http://127.0.0.1:9222/json/version');
  if (!response.ok) {
    throw new Error(`No se pudo leer Chrome DevTools: ${response.status}`);
  }
  const data = await response.json();
  if (!data.webSocketDebuggerUrl) {
    throw new Error('Chrome DevTools no publicó webSocketDebuggerUrl.');
  }
  return data.webSocketDebuggerUrl;
}

async function main() {
  const browserWs = await getBrowserWsUrl();
  const ws = new WebSocket(browserWs);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = [];

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }
    ws.send(JSON.stringify(message));
  });

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const current = pending.get(message.id);
      if (!current) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        current.reject(new Error(JSON.stringify(message.error)));
      } else {
        current.resolve(message.result);
      }
      return;
    }
    listeners.forEach(listener => listener(message));
  };

  const waitForLoad = sessionId => new Promise(resolve => {
    const handler = message => {
      if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
        const index = listeners.indexOf(handler);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
        resolve();
      }
    };
    listeners.push(handler);
  });

  const evaluate = async (sessionId, expression, awaitPromise = true) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Error evaluando expresión.');
    }
    return result.result.value;
  };

  const navigate = async (sessionId, url) => {
    const loaded = waitForLoad(sessionId);
    await send('Page.navigate', { url }, sessionId);
    await loaded;
    await wait(1000);
  };

  const waitFor = async (sessionId, expression, timeoutMs = 30000, pollMs = 250) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await evaluate(sessionId, expression);
      if (value) {
        return value;
      }
      await wait(pollMs);
    }
    throw new Error(`Tiempo de espera agotado: ${expression}`);
  };

  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    await navigate(sessionId, ROOT_URL);

    const hasTerms = await evaluate(sessionId, "!!document.getElementById('chkAceptarTerminos')");
    if (hasTerms) {
      await evaluate(sessionId, `(() => {
        const checkbox = document.getElementById('chkAceptarTerminos');
        const button = document.getElementById('BotonSiguiente');
        const link = document.getElementById('EnlaceSiguiente');
        if (checkbox) {
          checkbox.checked = true;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (button && !button.classList.contains('hidden')) {
          button.click();
        }
        if (link) {
          link.click();
          return true;
        }
        return false;
      })()`);
      await wait(1500);
    }

    let onSocioDashboard = await evaluate(sessionId, "!!document.getElementById('cboEstado')");
    if (!onSocioDashboard) {
      const socioLink = await evaluate(sessionId, `(() => {
        const link = document.querySelector('a[href="/Dashboard/Sociodemografico"]');
        return link ? link.href : '';
      })()`);
      await navigate(sessionId, socioLink || SOCIO_URL);
      onSocioDashboard = await evaluate(sessionId, "!!document.getElementById('cboEstado')");
    }
    if (!onSocioDashboard) {
      throw new Error('No se pudo abrir el dashboard sociodemográfico.');
    }

    await waitFor(sessionId, `(() => {
      const select = document.getElementById('cboEstado');
      return !!select && Array.from(select.options).some(option => option.value === '${STATE_ID}');
    })()`, 30000);

    await evaluate(sessionId, `(() => {
      const select = document.getElementById('cboEstado');
      const text = '${STATE_TEXT}';
      const data = { id: '${STATE_ID}', text };
      select.value = '${STATE_ID}';
      if (window.jQuery) {
        window.jQuery('#cboEstado').val('${STATE_ID}').trigger('change');
        window.jQuery('#cboEstado').trigger({
          type: 'select2:select',
          params: { data }
        });
      }
      return {
        selectedValue: select.value,
        selectedText: select.options[select.selectedIndex] ? select.options[select.selectedIndex].text.trim() : ''
      };
    })()`);

    await waitFor(sessionId, `(() => {
      const input = document.getElementById('txtInput');
      const cookie = document.cookie.match(/(?:^|; )c=([^;]+)/);
      return !!input && !!cookie;
    })()`, 15000);

    await evaluate(sessionId, `(() => {
      const input = document.getElementById('txtInput');
      const match = document.cookie.match(/(?:^|; )c=([^;]+)/);
      if (!input || !match) {
        return false;
      }
      input.value = decodeURIComponent(match[1]).replace(/\\s+/g, '');
      document.getElementById('BtnGenerarGrafica').click();
      return true;
    })()`);

    const result = await waitFor(sessionId, `(() => {
      const ids = ${JSON.stringify(METRIC_IDS)};
      const metrics = Object.fromEntries(Object.entries(ids).map(([key, id]) => {
        const node = document.getElementById(id);
        return [key, node ? node.innerText.replace(/\\s+/g, ' ').trim() : ''];
      }));
      if (!Object.values(metrics).every(Boolean)) {
        return null;
      }
      return {
        metrics,
        verification: {
          url: location.href,
          dropdownValue: document.getElementById('cboEstado') ? document.getElementById('cboEstado').value : '',
          dropdownText: (() => {
            const select = document.getElementById('cboEstado');
            const option = select && select.options[select.selectedIndex];
            return option ? option.text.trim() : '';
          })()
        }
      };
    })()`, 45000, 500);

    console.log(JSON.stringify(result, null, 2));
    console.log('');
    console.log('Verificación manual: en la pestaña abierta confirma que el filtro de estado siga mostrando CIUDAD DE MEXICO y que cboEstado valga 9 antes de usar los cinco valores.');
  } finally {
    ws.close();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});

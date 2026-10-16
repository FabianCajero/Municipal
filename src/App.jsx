import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import * as XLSX from 'xlsx';

const metricColumns = [
  { key: 'total', label: 'Total' },
  { key: 'desaparecidasNoLocalizadas', label: 'Missing / Not located' },
  { key: 'localizadas', label: 'Located' },
  { key: 'localizadasSinVida', label: 'Located deceased' },
  { key: 'localizadasConVida', label: 'Located alive' }
];

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

const defaultScript = `{
  "metrics": {
    "total": 103,
    "desaparecidasNoLocalizadas": 42,
    "localizadas": 61,
    "localizadasSinVida": 13,
    "localizadasConVida": 48
  },
  "verification": {
    "url": "https://versionpublicarnpdno.segob.gob.mx/Dashboard/Sociodemografico",
    "dropdownValue": "9",
    "dropdownText": "CIUDAD DE MEXICO"
  }
}`;

const emptyFilters = {
  from: '',
  to: '',
  status: 'all',
  sort: 'desc'
};

function formatDateTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(',').map(header => header.trim()) || [];
  return lines.filter(Boolean).map(line => {
    const values = line.split(',');
    return headers.reduce((row, header, index) => {
      row[header] = values[index]?.trim() ?? '';
      return row;
    }, {});
  });
}

function parseScriptOutput(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    const jsonLine = rawText.split(/\r?\n/).find(line => line.trim().startsWith('{'));
    if (jsonLine) {
      return JSON.parse(jsonLine);
    }
    return null;
  }
}

function classifyResult(result, errorText) {
  if (errorText) return 'Execution error';
  if (result?.metrics) return 'Metrics snapshot';
  if (result) return 'Structured JSON';
  return 'Raw text';
}

function normalizeMetrics(metrics) {
  return metricColumns.reduce((accumulator, column) => {
    const numeric = Number(metrics?.[column.key]);
    accumulator[column.key] = Number.isFinite(numeric) ? numeric : null;
    return accumulator;
  }, {});
}

function App() {
  const [scriptSource, setScriptSource] = useState(defaultScript);
  const [scriptName, setScriptName] = useState('default-rnpdno-dashboard-cdmx.js');
  const [history, setHistory] = useState([]);
  const [filters, setFilters] = useState(emptyFilters);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browserWsUrl, setBrowserWsUrl] = useState('');

  useEffect(() => {
    const saved = window.localStorage.getItem('query-dashboard-history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setHistory(parsed);
        setSelectedId(parsed[0]?.id || null);
      } catch {
        window.localStorage.removeItem('query-dashboard-history');
      }
    } else {
      loadSampleData();
    }
    void loadBrowserWsUrl();
  }, []);

  async function loadBrowserWsUrl() {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/version');
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      if (payload.webSocketDebuggerUrl) {
        setBrowserWsUrl(payload.webSocketDebuggerUrl);
      }
    } catch {
      setBrowserWsUrl('');
    }
  }

  useEffect(() => {
    window.localStorage.setItem('query-dashboard-history', JSON.stringify(history));
  }, [history]);

  const visibleRows = useMemo(() => {
    const filtered = history.filter(item => {
      const timestamp = new Date(item.executedAt).getTime();
      if (filters.from && timestamp < new Date(filters.from).getTime()) return false;
      if (filters.to && timestamp > new Date(filters.to).getTime()) return false;
      if (filters.status !== 'all' && item.status !== filters.status) return false;
      return true;
    });
    return filtered.sort((left, right) => {
      const leftTime = new Date(left.executedAt).getTime();
      const rightTime = new Date(right.executedAt).getTime();
      return filters.sort === 'asc' ? leftTime - rightTime : rightTime - leftTime;
    });
  }, [filters, history]);

  const selectedRun = visibleRows.find(item => item.id === selectedId) || visibleRows[0] || null;

  const timelineData = useMemo(
    () =>
      [...visibleRows]
        .sort((left, right) => new Date(left.executedAt).getTime() - new Date(right.executedAt).getTime())
        .map(item => ({
          timestamp: formatDateTime(item.executedAt),
          ...item.metricsNormalized
        })),
    [visibleRows]
  );

  const latestBreakdown = useMemo(() => {
    if (!selectedRun?.metricsNormalized) return [];
    return metricColumns.map(column => ({
      metric: column.label,
      value: selectedRun.metricsNormalized[column.key] ?? 0
    }));
  }, [selectedRun]);

  async function handleRunScript() {
    setBusy(true);
    setError('');
    try {
      const parsed = await runRealQuery();

      const record = {
        id: crypto.randomUUID(),
        scriptName,
        executedAt: new Date().toISOString(),
        status: 'success',
        exitCode: 0,
        classification: classifyResult(parsed, ''),
        metricsNormalized: normalizeMetrics(parsed.metrics),
        parsedResult: parsed,
        verification: parsed.verification || null,
        stdout: scriptSource,
        stderr: ''
      };

      setHistory(current => [record, ...current]);
      setSelectedId(record.id);
    } catch (runError) {
      const record = {
        id: crypto.randomUUID(),
        scriptName,
        executedAt: new Date().toISOString(),
        status: 'failed',
        exitCode: 1,
        classification: 'Execution error',
        metricsNormalized: normalizeMetrics({}),
        parsedResult: null,
        verification: null,
        stdout: '',
        stderr: runError.message
      };
      setHistory(current => [record, ...current]);
      setSelectedId(record.id);
      setError(runError.message);
    } finally {
      setBusy(false);
    }
  }

  function handleFileLoad(event) {
    const [file] = event.target.files || [];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setScriptSource(String(reader.result || ''));
      setScriptName(file.name);
      setError('');
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  function loadSampleData() {
    const csv = `executedAt,status,classification,total,desaparecidasNoLocalizadas,localizadas,localizadasSinVida,localizadasConVida
2026-10-16T10:15:00Z,success,Metrics snapshot,100,40,60,12,48
2026-10-16T11:15:00Z,success,Metrics snapshot,102,41,61,13,48
2026-10-16T12:15:00Z,success,Metrics snapshot,103,42,61,13,48`;
    const sample = parseCsv(csv).map(row => ({
      id: crypto.randomUUID(),
      scriptName: 'sample-import.csv',
      executedAt: row.executedAt,
      status: row.status,
      exitCode: 0,
      classification: row.classification,
      metricsNormalized: {
        total: Number(row.total),
        desaparecidasNoLocalizadas: Number(row.desaparecidasNoLocalizadas),
        localizadas: Number(row.localizadas),
        localizadasSinVida: Number(row.localizadasSinVida),
        localizadasConVida: Number(row.localizadasConVida)
      },
      parsedResult: null,
      verification: null,
      stdout: '',
      stderr: ''
    }));
    setHistory(sample);
    setSelectedId(sample[0]?.id || null);
  }

  async function runRealQuery() {
    if (!browserWsUrl) {
      throw new Error('No hay un navegador con DevTools disponible en http://127.0.0.1:9222.');
    }

    const ws = new WebSocket(browserWsUrl);
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
      if (sessionId) message.sessionId = sessionId;
      ws.send(JSON.stringify(message));
    });

    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const current = pending.get(message.id);
        if (!current) return;
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
          if (index >= 0) listeners.splice(index, 1);
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
      await new Promise(resolve => setTimeout(resolve, 1000));
    };

    const waitFor = async (sessionId, expression, timeoutMs = 30000, pollMs = 250) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const value = await evaluate(sessionId, expression);
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, pollMs));
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
      const socioLink = await evaluate(sessionId, `(() => {
        const link = document.querySelector('a[href="/Dashboard/Sociodemografico"]');
        return link ? link.href : '';
      })()`);
      await navigate(sessionId, socioLink || SOCIO_URL);

      await waitFor(sessionId, `(() => {
        const select = document.getElementById('cboEstado');
        return !!select && Array.from(select.options).some(option => option.value === '${STATE_ID}');
      })()`, 30000);

      await evaluate(sessionId, `(() => {
        const select = document.getElementById('cboEstado');
        select.value = '${STATE_ID}';
        if (window.jQuery) {
          window.jQuery('#cboEstado').val('${STATE_ID}').trigger('change');
          window.jQuery('#cboEstado').trigger({ type: 'select2:select', params: { data: { id: '${STATE_ID}', text: '${STATE_TEXT}' } } });
        }
      })()`);

      await waitFor(sessionId, `(() => {
        const input = document.getElementById('txtInput');
        const cookie = document.cookie.match(/(?:^|; )c=([^;]+)/);
        return !!input && !!cookie;
      })()`, 15000);

      await evaluate(sessionId, `(() => {
        const input = document.getElementById('txtInput');
        const match = document.cookie.match(/(?:^|; )c=([^;]+)/);
        if (!input || !match) return false;
        input.value = decodeURIComponent(match[1]).replace(/\\s+/g, '');
        const button = document.getElementById('BtnGenerarGrafica');
        if (button) button.click();
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

      ws.close();
      return result;
    } catch (error) {
      ws.close();
      throw error;
    }
  }

  function exportVisibleRows() {
    if (visibleRows.length === 0) {
      setError('There is no visible data to export.');
      return;
    }

    const rows = visibleRows.map(item => ({
      'Query time': formatDateTime(item.executedAt),
      Status: item.status,
      Classification: item.classification,
      'Script name': item.scriptName,
      'Exit code': item.exitCode
    }));
    visibleRows.forEach((item, index) => {
      metricColumns.forEach(column => {
        rows[index][column.label] = item.metricsNormalized?.[column.key] ?? '';
      });
    });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Visible Data');
    const fileName = `query-results-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;
    XLSX.writeFile(workbook, fileName, { bookType: 'xlsx' });
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Web-only script dashboard</p>
          <h1>Script Query Dashboard</h1>
          <p className="subtle">
            Run a script payload, inspect the returned JSON, classify the result by query time,
            chart it, and export the visible rows as XLS.
          </p>
        </div>
        <div className="button-row">
          <button onClick={loadSampleData}>Load sample data</button>
          <button className="primary-button" onClick={exportVisibleRows}>
            Export visible rows (.xlsx)
          </button>
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}

      <div className="panel script-panel">
        <div className="panel-header">
          <div>
            <h2>Script input</h2>
            <p className="subtle">Paste the attached JavaScript or load a file.</p>
          </div>
          <div className="button-row">
            <button onClick={() => setScriptSource(defaultScript)}>Reload default</button>
            <button onClick={() => document.getElementById('file-input')?.click()}>Load file</button>
            <button className="primary-button" onClick={handleRunScript} disabled={busy}>
              {busy ? 'Running…' : 'Run script'}
            </button>
          </div>
        </div>

        <input id="file-input" type="file" accept=".js,.mjs,.cjs,.txt,.json,.csv" hidden onChange={handleFileLoad} />
        <label className="field-label" htmlFor="scriptName">Script name</label>
        <input className="text-input" id="scriptName" value={scriptName} onChange={event => setScriptName(event.target.value)} />
        <label className="field-label" htmlFor="scriptSource">Script source / output</label>
        <textarea className="script-area" id="scriptSource" value={scriptSource} onChange={event => setScriptSource(event.target.value)} />
      </div>

      <section className="summary-grid">
        <article className="summary-card"><span>Visible queries</span><strong>{visibleRows.length}</strong></article>
        <article className="summary-card"><span>Successful</span><strong>{visibleRows.filter(item => item.status === 'success').length}</strong></article>
        <article className="summary-card"><span>Failed</span><strong>{visibleRows.filter(item => item.status === 'failed').length}</strong></article>
        <article className="summary-card"><span>Latest run</span><strong>{formatDateTime(history[0]?.executedAt)}</strong></article>
      </section>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Filter and sort</h2>
            <p className="subtle">Classify and compare results by date/time of query.</p>
          </div>
        </div>
        <div className="filter-grid">
          <label><span>From</span><input type="datetime-local" value={filters.from} onChange={event => setFilters(current => ({ ...current, from: event.target.value }))} /></label>
          <label><span>To</span><input type="datetime-local" value={filters.to} onChange={event => setFilters(current => ({ ...current, to: event.target.value }))} /></label>
          <label>
            <span>Status</span>
            <select value={filters.status} onChange={event => setFilters(current => ({ ...current, status: event.target.value }))}>
              <option value="all">All</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select value={filters.sort} onChange={event => setFilters(current => ({ ...current, sort: event.target.value }))}>
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </label>
          <div className="filter-actions">
            <button onClick={() => setFilters(emptyFilters)}>Reset filters</button>
          </div>
        </div>
      </div>

      <section className="chart-grid">
        <div className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Metrics over query time</h2>
              <p className="subtle">Timeline for the filtered executions.</p>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={timelineData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="timestamp" minTickGap={24} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="total" stroke="#2563eb" strokeWidth={2} />
                <Line type="monotone" dataKey="desaparecidasNoLocalizadas" stroke="#dc2626" strokeWidth={2} />
                <Line type="monotone" dataKey="localizadas" stroke="#059669" strokeWidth={2} />
                <Line type="monotone" dataKey="localizadasSinVida" stroke="#f97316" strokeWidth={2} />
                <Line type="monotone" dataKey="localizadasConVida" stroke="#7c3aed" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Latest visible breakdown</h2>
              <p className="subtle">Selected run detail chart.</p>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={latestBreakdown}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="metric" interval={0} angle={-15} textAnchor="end" height={80} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="value" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel chart-panel chart-panel-wide">
          <div className="panel-header">
            <div>
              <h2>Located vs missing trend</h2>
              <p className="subtle">Area chart to compare the main categories over time.</p>
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={timelineData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="timestamp" minTickGap={24} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Area type="monotone" dataKey="localizadasConVida" stackId="1" stroke="#16a34a" fill="#86efac" />
                <Area type="monotone" dataKey="localizadasSinVida" stackId="1" stroke="#f97316" fill="#fdba74" />
                <Area type="monotone" dataKey="desaparecidasNoLocalizadas" stackId="2" stroke="#dc2626" fill="#fca5a5" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="results-layout">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Captured results</h2>
              <p className="subtle">Click a row to inspect parsed output and raw text.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Query time</th>
                  <th>Status</th>
                  <th>Classification</th>
                  {metricColumns.map(column => <th key={column.key}>{column.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(item => (
                  <tr key={item.id} className={item.id === selectedRun?.id ? 'selected-row' : ''} onClick={() => setSelectedId(item.id)}>
                    <td>{formatDateTime(item.executedAt)}</td>
                    <td><span className={`pill pill-${item.status}`}>{item.status}</span></td>
                    <td>{item.classification}</td>
                    {metricColumns.map(column => <td key={column.key}>{item.metricsNormalized?.[column.key] ?? '—'}</td>)}
                  </tr>
                ))}
                {visibleRows.length === 0 ? (
                  <tr><td colSpan={8} className="empty-state">No rows match the current filters.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel details-panel">
          <div className="panel-header">
            <div>
              <h2>Run details</h2>
              <p className="subtle">Structured payload and raw data for the selected row.</p>
            </div>
          </div>

          {selectedRun ? (
            <div className="details-grid">
              <div>
                <h3>Metadata</h3>
                <dl className="detail-list">
                  <div><dt>Script</dt><dd>{selectedRun.scriptName}</dd></div>
                  <div><dt>Executed</dt><dd>{formatDateTime(selectedRun.executedAt)}</dd></div>
                  <div><dt>Status</dt><dd>{selectedRun.status}</dd></div>
                  <div><dt>Classification</dt><dd>{selectedRun.classification}</dd></div>
                </dl>
              </div>
              <div>
                <h3>Parsed result</h3>
                <pre>{JSON.stringify(selectedRun.parsedResult, null, 2) || 'No structured JSON detected.'}</pre>
              </div>
              <div>
                <h3>Verification</h3>
                <pre>{JSON.stringify(selectedRun.verification, null, 2) || 'No verification block detected.'}</pre>
              </div>
              <div>
                <h3>Raw source/output</h3>
                <pre>{selectedRun.stdout || 'No raw output captured.'}</pre>
              </div>
              <div>
                <h3>Errors</h3>
                <pre>{selectedRun.stderr || 'No errors captured.'}</pre>
              </div>
            </div>
          ) : (
            <p className="subtle">Run the script or load sample data to begin.</p>
          )}
        </div>
      </section>
    </div>
  );
}

export default App;

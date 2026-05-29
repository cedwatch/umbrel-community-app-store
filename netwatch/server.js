#!/usr/bin/env node
'use strict';

// ============================================================
// NetWatch Standalone v1.2
// ced.watch - MIT - github.com/cedwatch
// Node.js pure, zero npm dependencies
// ============================================================

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { execFile } = require('child_process');

const VERSION  = '1.3.1';
const PORT     = parseInt(process.env.NETWATCH_PORT || '5217', 10);
const BASE_DIR = path.dirname(process.argv[1]);
const DATA_FILE   = path.join(BASE_DIR, 'data.json');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const SPEEDTEST   = path.join(BASE_DIR, 'bin', 'speedtest');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const DEFAULT_CONFIG = {
  interval:   30,
  threshDl:   5,
  threshPing: 100,
  skin:       0,
  paused:     false,
  tailscaleOnly: false,
  tailscaleIP: '',
};

// -- State
let cfg           = Object.assign({}, DEFAULT_CONFIG);
// tailscaleIP is now read from cfg.tailscaleIP (manually set by user)
let db         = [];
let scheduler  = null;
let running    = false;
let nextRun    = null;
let updateInfo = null;
let burstCount = 0;
const BURST_TOTAL = 6;
const BURST_RETURN = 30;

// -- Config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg = Object.assign({}, DEFAULT_CONFIG, raw);
    } else { saveConfig(); }
  } catch(e) { console.error('[config]', e.message); }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
  catch(e) { console.error('[config save]', e.message); }
}

// -- Data
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!Array.isArray(db)) db = [];
    }
  } catch(e) { db = []; }
  pruneData();
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }
  catch(e) { console.error('[data save]', e.message); }
}
function pruneData() {
  const cut = Date.now() - 90 * 86400000;
  db = db.filter(function(r) { return r.ts >= cut; });
}
function appendRecord(rec) {
  db.push(rec);
  pruneData();
  saveData();
}

// -- Cardinal scheduler
function nextCardinal(intervalMin) {
  const now  = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const next = Math.ceil((mins + 1) / intervalMin) * intervalMin;
  const d    = new Date(now);
  d.setHours(Math.floor(next / 60) % 24, next % 60, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

function startScheduler() {
  if (scheduler) clearTimeout(scheduler);
  if (cfg.paused) { nextRun = null; return; }
  nextRun = nextCardinal(cfg.interval);
  const ms = nextRun - Date.now();
  console.log('[scheduler] interval=' + cfg.interval + 'min next=' + nextRun.toISOString());
  scheduler = setTimeout(function() {
    runCycle().then(function() {
      // Burst mode: if interval=5, after BURST_TOTAL cycles auto-revert to BURST_RETURN
      if (cfg.interval === 5) {
        burstCount++;
        if (burstCount >= BURST_TOTAL) {
          burstCount = 0;
          cfg.interval = BURST_RETURN;
          saveConfig();
          console.log('[scheduler] burst complete, reverting to ' + BURST_RETURN + 'min');
        }
      }
      startScheduler();
    });
  }, ms);
}

// -- Ookla
function runOokla() {
  return new Promise(function(resolve) {
    if (!fs.existsSync(SPEEDTEST)) { resolve(null); return; }
    execFile(SPEEDTEST, ['--format=json','--accept-license','--accept-gdpr'],
      { timeout: 120000 }, function(err, stdout) {
      if (err) { console.error('[ookla]', err.message); resolve(null); return; }
      try {
        const r = JSON.parse(stdout);
        resolve({
          dl:     parseFloat((r.download.bandwidth * 8 / 1000000).toFixed(2)),
          ul:     parseFloat((r.upload.bandwidth   * 8 / 1000000).toFixed(2)),
          ping:   parseFloat(r.ping.latency.toFixed(1)),
          jitter: parseFloat((r.ping.jitter || 0).toFixed(1)),
          server: (r.server.name || '') + (r.server.location ? ' - ' + r.server.location : ''),
          isp:    r.isp || '',
        });
      } catch(e) { console.error('[ookla parse]', e.message); resolve(null); }
    });
  });
}

// -- Cloudflare
function runCF() {
  return new Promise(function(resolve) {

    function measureLatency(cb) {
      var pings = [], done = 0;
      function doPing() {
        var t0 = Date.now();
        var req = https.get({
          hostname: 'speed.cloudflare.com', path: '/cdn-cgi/trace',
          headers: { 'User-Agent': 'netwatch/1.2' }
        }, function(r) {
          r.resume();
          r.on('end', function() {
            pings.push(Date.now() - t0); done++;
            if (done < 5) doPing();
            else { pings.sort(function(a,b){return a-b;}); cb({ ping: pings[2], jitter: pings[4]-pings[0] }); }
          });
        });
        req.on('error', function() { done++; if (done>=5) cb({ping:0,jitter:0}); });
        req.setTimeout(5000, function() { req.destroy(); });
      }
      doPing();
    }

    function measureDownload(cb) {
      var t0 = Date.now(), deadline = t0+10000, total = 0, finished = false;
      function doChunk() {
        if (finished) return;
        var req = https.get({
          hostname: 'speed.cloudflare.com', path: '/__down?bytes=26214400',
          headers: { 'User-Agent': 'netwatch/1.2' }
        }, function(r) {
          r.on('data', function(chunk) {
            total += chunk.length;
            if (Date.now() >= deadline && !finished) {
              finished = true; r.destroy();
              cb(parseFloat(((total*8)/((Date.now()-t0)/1000)/1000000).toFixed(2)));
            }
          });
          r.on('end', function() { if (!finished && Date.now()<deadline) doChunk(); });
          r.on('error', function() {});
        });
        req.on('error', function() {});
        req.setTimeout(15000, function() { req.destroy(); });
      }
      doChunk(); doChunk(); doChunk();
      setTimeout(function() {
        if (!finished) { finished = true;
          cb(parseFloat(((total*8)/((Date.now()-t0)/1000)/1000000).toFixed(2))); }
      }, 12000);
    }

    function measureUpload(cb) {
      var t0 = Date.now(), deadline = t0+8000, total = 0, finished = false;
      var CHUNK = Buffer.alloc(1048576, 65);
      function doUpload() {
        if (finished) return;
        var req = https.request({
          method: 'POST', hostname: 'speed.cloudflare.com', path: '/__up',
          headers: { 'User-Agent': 'netwatch/1.2', 'Content-Type': 'application/octet-stream', 'Content-Length': CHUNK.length*10 }
        }, function(r) {
          r.resume();
          r.on('end', function() { if (!finished && Date.now()<deadline) doUpload(); });
        });
        req.on('error', function() {});
        req.setTimeout(12000, function() { req.destroy(); });
        var w = 0;
        function wr() {
          if (finished||w>=10) { req.end(); return; }
          if (Date.now()>=deadline) {
            finished = true; req.end();
            cb(parseFloat(((total*8)/((Date.now()-t0)/1000)/1000000).toFixed(2))); return;
          }
          var ok = req.write(CHUNK); total += CHUNK.length; w++;
          if (ok) wr(); else req.once('drain', wr);
        }
        wr();
      }
      doUpload(); doUpload();
      setTimeout(function() {
        if (!finished) { finished = true;
          cb(parseFloat(((total*8)/((Date.now()-t0)/1000)/1000000).toFixed(2))); }
      }, 11000);
    }

    measureLatency(function(lat) {
      measureDownload(function(dl) {
        measureUpload(function(ul) {
          resolve({ ping: lat.ping, jitter: lat.jitter, dl: dl, ul: ul });
        });
      });
    });
  });
}

// -- Cycle
function runCycle() {
  if (running) return Promise.resolve(null);
  running = true;
  var ts = Date.now(), created = new Date(ts).toISOString();
  console.log('[cycle] start', created);
  return runOokla().then(function(ookla) {
    console.log('[ookla]', ookla ? ookla.dl+'Mbps' : 'FAIL');
    return runCF().then(function(cf) {
      console.log('[cf]', cf ? cf.dl+'Mbps' : 'FAIL');
      var rec = { ts:ts, created:created, ookla:ookla, cf:cf,
        status: (!ookla&&!cf)?'fail':(!ookla||!cf)?'partial':'ok' };
      appendRecord(rec);
      running = false;
      console.log('[cycle] done, total:', db.length);
      return rec;
    });
  }).catch(function(e) { console.error('[cycle]', e.message); running = false; return null; });
}

// -- Self-update
function checkUpdate(cb) {
  var req = https.get({
    hostname: 'api.github.com',
    path: '/repos/cedwatch/netwatch/releases/latest',
    headers: { 'User-Agent': 'netwatch/'+VERSION }
  }, function(r) {
    var body = '';
    r.on('data', function(c) { body += c; });
    r.on('end', function() {
      try {
        var rel = JSON.parse(body);
        var ver = (rel.tag_name||'').replace(/^v/,'');
        cb(null, { current:VERSION, latest:ver, newer:isNewer(ver,VERSION), url:rel.html_url||'' });
      } catch(e) { cb(e.message); }
    });
  });
  req.on('error', function(e) { cb(e.message); });
  req.setTimeout(10000, function() { req.destroy(); cb('timeout'); });
}
function isNewer(a, b) {
  var pa=a.split('.').map(Number), pb=b.split('.').map(Number);
  for (var i=0;i<3;i++) { if((pa[i]||0)>(pb[i]||0)) return true; if((pa[i]||0)<(pb[i]||0)) return false; }
  return false;
}
function doUpdate(cb) {
  var req = https.get({
    hostname: 'raw.githubusercontent.com',
    path: '/cedwatch/netwatch/main/server.js',
    headers: { 'User-Agent': 'netwatch/'+VERSION }
  }, function(r) {
    if (r.statusCode !== 200) { cb('HTTP '+r.statusCode); return; }
    var body = '';
    r.on('data', function(c) { body += c; });
    r.on('end', function() {
      try {
        var self = path.join(BASE_DIR, 'server.js');
        fs.writeFileSync(self+'.bak', fs.readFileSync(self));
        fs.writeFileSync(self, body);
        cb(null);
        setTimeout(function() { process.exit(0); }, 1000);
      } catch(e) { cb(e.message); }
    });
  });
  req.on('error', function(e) { cb(e.message); });
}

// -- HTTP helpers
function jsonResp(res, status, obj) {
  res.writeHead(status, Object.assign({'Content-Type':'application/json'}, CORS));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(function(resolve) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}
function parseCookies(req) {
  var out = {}, h = req.headers.cookie || '';
  h.split(';').forEach(function(p) {
    var i = p.indexOf('=');
    if (i<0) return;
    out[p.slice(0,i).trim()] = p.slice(i+1).trim();
  });
  return out;
}
function parseQuery(url) {
  var q = {}, qs = url.includes('?') ? url.split('?')[1] : '';
  qs.split('&').forEach(function(p) {
    var kv = p.split('=');
    if (kv[0]) q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]||'');
  });
  return q;
}

// -- API
function handleAPI(req, res) {
  var method = req.method;
  var url    = req.url.split('?')[0];
  var query  = parseQuery(req.url);

  if (url === '/api/speedtests' && method === 'GET') {
    var hours = parseInt(query.hours||'0', 10);
    var cut   = hours > 0 ? Date.now() - hours*3600000 : 0;
    var rows  = cut > 0 ? db.filter(function(r){return r.ts>=cut;}) : db.slice();
    return jsonResp(res, 200, rows.reverse());
  }
  if (url === '/api/speedtests/run' && method === 'POST') {
    if (running) return jsonResp(res, 409, { message:'Already running' });
    if (cfg.paused) return jsonResp(res, 410, { message:'Tests paused' });
    jsonResp(res, 200, { message:'Started' });
    runCycle().then(function() { startScheduler(); });
    return;
  }
  if (url === '/api/status' && method === 'GET') {
    return jsonResp(res, 200, {
      running:      running,
      paused:       cfg.paused,
      nextRun:      nextRun ? nextRun.toISOString() : null,
      total:        db.length,
      ooklaPresent: fs.existsSync(SPEEDTEST),
      cfOk:         db.length > 0 && db[db.length-1].cf !== null,
      version:      VERSION,
      burstActive:  cfg.interval === 5 && burstCount > 0,
      burstCount:   burstCount,
      burstTotal:   BURST_TOTAL,
      tailscaleOnly: cfg.tailscaleOnly,
      tailscaleIP:   cfg.tailscaleIP || '',
      tailscaleOk:   !!(cfg.tailscaleIP && cfg.tailscaleIP.match(/^100\.\d+\.\d+\.\d+$/)),
    });
  }
  if (url === '/api/config' && method === 'GET') {
    return jsonResp(res, 200, Object.assign({}, cfg, {
      ooklaPresent: fs.existsSync(SPEEDTEST), version: VERSION
    }));
  }
  if (url === '/api/config' && method === 'POST') {
    readBody(req).then(function(body) {
      try {
        var u = JSON.parse(body);
        var allowed = ['interval','threshDl','threshPing','skin','paused','tailscaleOnly','tailscaleIP'];
        allowed.forEach(function(k) { if (u[k] !== undefined) cfg[k] = u[k]; });
        if (u.interval !== undefined) burstCount = 0; // reset burst on manual interval change
        saveConfig();
        if (u.interval !== undefined || u.paused !== undefined) startScheduler();
        jsonResp(res, 200, { message:'Saved' });
      } catch(e) { jsonResp(res, 400, { message:'Invalid JSON' }); }
    });
    return;
  }
  if (url === '/api/update/check' && method === 'GET') {
    checkUpdate(function(err, info) {
      if (err) return jsonResp(res, 500, { message:err });
      updateInfo = info;
      jsonResp(res, 200, info);
    });
    return;
  }
  if (url === '/api/update/install' && method === 'POST') {
    if (!updateInfo || !updateInfo.newer) return jsonResp(res, 400, { message:'No update available' });
    if (cfg.tailscaleOnly) {
      var remoteIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      var remoteClean = remoteIP.replace(/^.*:/, '');
      var allowed = ['127.0.0.1', '::1', cfg.tailscaleIP || ''];
      if (!allowed.includes(remoteClean)) {
        return jsonResp(res, 403, { message:'Update install blocked: use Tailscale IP to access' });
      }
    }
    jsonResp(res, 200, { message:'Updating, restarting...' });
    doUpdate(function(err) { if (err) console.error('[update]', err); });
    return;
  }
  if (url === '/api/restart' && method === 'POST') {
    jsonResp(res, 200, { message:'Restarting...' });
    setTimeout(function() { process.exit(0); }, 500);
    return;
  }
  if (url === '/health' && method === 'GET') {
    return jsonResp(res, 200, { ok:true, records:db.length, version:VERSION });
  }
  jsonResp(res, 404, { message:'Not found' });
}

// -- HTML
function buildHTML(skinIdx) {
  var sk = [['sk-kampot','Kampot'],['sk-mekong','Mekong'],['sk-kep','Kep']][skinIdx] || ['sk-kampot','Kampot'];
  return HTML_BASE
    .replace('%%SKIN_CLASS%%', sk[0])
    .replace('%%SKIN_NAME%%', sk[1])
    .replace('%%SKIN_IDX%%',  String(skinIdx));
}

var HTML_BASE = [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1.0">',
'<title>NetWatch</title>',
'<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap" rel="stylesheet">',
'<style>',
'.sk-kampot{--bg:#080f0a;--sf:#0e1a11;--br:#1a2e1e;--ac:#2ecc71;--ad:#1a6b3a;--am:#f0a500;--rd:#e74c3c;--bl:#4a90d9;--dm:#4a6b52;--td:#5a7a5f;--tx:#b8d4bc;--th:#e0f0e4;--sh:none;--gc:rgba(46,204,113,.03)}',
'.sk-mekong{--bg:#100c04;--sf:#1a1408;--br:#2e2210;--ac:#f0a500;--ad:#7a5200;--am:#e07000;--rd:#e74c3c;--bl:#5aaced;--dm:#7a6030;--td:#9a8050;--tx:#e8d8a8;--th:#fff8e0;--sh:none;--gc:rgba(240,165,0,.03)}',
'.sk-kep{--bg:#f4efe4;--sf:#ffffff;--br:#ddd5c0;--ac:#0a9396;--ad:#94d2bd;--am:#ee9b00;--rd:#ae2012;--bl:#005f73;--dm:#6b705c;--td:#7a7560;--tx:#2d2a1e;--th:#050400;--sh:0 1px 4px rgba(0,0,0,.09);--gc:rgba(10,147,150,.04)}',
'*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
'body{background:var(--bg);color:var(--tx);font-family:\'Syne\',sans-serif;min-height:100vh;overflow-x:hidden;transition:background .35s,color .35s}',
'body::before{content:\'\';position:fixed;inset:0;background-image:linear-gradient(var(--gc) 1px,transparent 1px),linear-gradient(90deg,var(--gc) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}',
'.app{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:0 14px 28px}',
'header{display:flex;align-items:center;justify-content:space-between;padding:12px 0 9px;border-bottom:1px solid var(--br)}',
'.logo{cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}',
'.logo h1{font-size:20px;font-weight:800;color:var(--ac);letter-spacing:-.5px;transition:color .35s;display:inline}',
'.logo .skname{font-family:\'Space Mono\',monospace;font-size:10px;color:var(--dm);letter-spacing:1px;margin-left:8px;transition:color .35s;display:inline}',
'.logo:hover .skname{color:var(--ac)}',
'.hdr-time{font-family:\'Space Mono\',monospace;font-size:13px;font-weight:700;color:var(--th);letter-spacing:.5px}',
'.actions{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--br)}',
'.pill{display:flex;align-items:center;gap:5px;font-family:\'Space Mono\',monospace;font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid var(--br);background:var(--sf);color:var(--dm);transition:all .3s;white-space:nowrap;max-width:180px;overflow:hidden}',
'.pill.live{border-color:var(--ad);color:var(--ac)}.pill.live .dot{background:var(--ac);animation:pu 1.8s infinite}',
'.pill.run{border-color:var(--am);color:var(--am)}.pill.run .dot{background:var(--am);animation:pu .6s infinite}',
'.pill.err{border-color:var(--rd);color:var(--rd)}.pill.err .dot{background:var(--rd)}',
'.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--dm)}',
'@keyframes pu{0%,100%{opacity:1}50%{opacity:.3}}',
'.btn{font-family:\'Space Mono\',monospace;font-size:11px;font-weight:700;padding:5px 11px;border-radius:6px;border:1px solid var(--br);background:var(--sf);color:var(--dm);cursor:pointer;transition:all .15s;white-space:nowrap;-webkit-tap-highlight-color:transparent}',
'.btn:hover{border-color:var(--ac);color:var(--ac)}',
'.btn.go{border-color:var(--ac);color:var(--ac)}.btn.go:hover,.btn.go:active{background:var(--ad);color:var(--th)}',
'.btn.on{background:var(--ad);border-color:var(--ac);color:var(--th)}',
'.btn.warn{border-color:var(--am);color:var(--am)}.btn.warn.on{background:var(--am);color:#000}',
'.btn.sec{border-color:var(--bl);color:var(--bl)}.btn.sec.on{background:var(--bl);color:var(--th)}',
'.btn-sync{font-size:17px;padding:4px 10px;border:2px solid var(--ac);border-radius:6px;background:var(--ad);color:var(--th);cursor:pointer}',
'.btn-gear{font-size:13px;padding:4px 10px;border:1px solid var(--br);border-radius:6px;background:var(--sf);color:var(--td);cursor:pointer;margin-left:auto}',
'.btn-gear.on{background:var(--ad);border-color:var(--ac);color:var(--th)}',
'.spanel{display:none;background:var(--sf);border:1px solid var(--br);border-bottom:2px solid var(--ac);padding:10px 14px;margin-bottom:4px}',
'.spanel.open{display:block}',
'.sp-row{display:flex;align-items:center;gap:8px;padding:5px 0;flex-wrap:wrap;border-bottom:1px solid var(--br)}',
'.sp-row:last-child{border-bottom:none}',
'.sp-msg{font-family:\'Space Mono\',monospace;font-size:9px;padding:3px 0;min-height:16px;display:none}',
'.sp-msg.show{display:block}',
'.slbl{font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td);letter-spacing:1px;text-transform:uppercase;min-width:28px}',
'.bgrp{display:flex;gap:3px;flex-wrap:wrap}',
'input.ci{font-family:\'Space Mono\',monospace;font-size:11px;padding:4px 6px;background:var(--bg);border:1px solid var(--br);border-radius:6px;color:var(--tx);width:50px}',
'input.ci:focus{outline:none;border-color:var(--ac)}',
'input.ci.wide{width:120px}',
'.sp-status{font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td);display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
'.dot-ok{color:var(--ac)}.dot-fail{color:var(--rd)}.dot-na{color:var(--td)}',
'.burst-note{font-family:\'Space Mono\',monospace;font-size:9px;color:var(--am);margin-left:4px}',
'.upd-info{font-family:\'Space Mono\',monospace;font-size:10px;color:var(--ac)}',
'/* KPI grid */',
'.kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:8px 0}',
'.kpi-pair{display:contents}',
'.kpi{background:var(--sf);border:1px solid var(--br);border-radius:6px;padding:10px 12px;position:relative;overflow:hidden;box-shadow:var(--sh)}',
'.kpi::before{content:\'\';position:absolute;top:0;left:0;right:0;height:2px;background:var(--kc,var(--br))}',
'.kl{font-family:\'Space Mono\',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--td);margin-bottom:4px}',
'.kv{font-size:22px;font-weight:800;line-height:1;color:var(--kc,var(--dm))}',
'.ku{font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td);margin-left:2px}',
'.ks{font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td);margin-top:3px}',
'.ks-time{font-family:\'Space Mono\',monospace;font-size:12px;font-weight:700;color:var(--td);margin-top:3px}',
'.sbo{height:5px;background:var(--br);border-radius:3px;margin:5px 0 3px;overflow:hidden}',
'.sbi{height:100%;border-radius:3px;transition:width .8s,background .3s}',
'/* Recent cards */',
'.rec-wrap{padding:4px 0 2px}',
'.rec-lbl{font-family:\'Space Mono\',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--td);margin-bottom:6px}',
'.rec-scroll{display:flex;gap:8px;overflow-x:auto;padding-bottom:5px;-webkit-overflow-scrolling:touch;cursor:grab}',
'.rec-scroll::-webkit-scrollbar{height:3px}',
'.rec-scroll::-webkit-scrollbar-thumb{background:var(--ad);border-radius:2px}',
'.rcard{flex:0 0 128px;background:var(--sf);border:1px solid var(--br);border-radius:6px;padding:8px 10px;position:relative;overflow:hidden;box-shadow:var(--sh)}',
'.rcard::before{content:\'\';position:absolute;top:0;left:0;right:0;height:2px;background:var(--rc,var(--br))}',
'.rcard:first-child{border-color:var(--ac)}',
'.rc-time{font-family:\'Space Mono\',monospace;font-size:11px;font-weight:700;color:var(--tx);margin-bottom:5px}',
'.rc-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1px}',
'.rc-lbl{font-family:\'Space Mono\',monospace;font-size:8px;color:var(--td);text-transform:uppercase;letter-spacing:1px}',
'.rc-val{font-size:14px;font-weight:800;color:var(--ac)}.rc-val.bad{color:var(--rd)}',
'.rc-val2{font-size:14px;font-weight:800;color:var(--bl)}.rc-val2.bad{color:var(--rd)}',
'.rc-sub{font-family:\'Space Mono\',monospace;font-size:9px;font-weight:700;color:var(--ac);opacity:.75;margin-bottom:2px}',
'.rc-sub2{font-family:\'Space Mono\',monospace;font-size:9px;font-weight:700;color:var(--bl);opacity:.75;margin-bottom:2px}',
'.rc-u{font-family:\'Space Mono\',monospace;font-size:8px;color:var(--td)}',
'.rc-ping{font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td);margin-top:3px}',
'.badge{display:inline-block;font-family:\'Space Mono\',monospace;font-size:9px;padding:1px 6px;border-radius:3px;font-weight:700;margin-top:3px}',
'.b-ok{background:#0e2e18;color:#2ecc71}.b-w{background:#2e1e08;color:#f0a500}.b-bad{background:#2e0e0e;color:#e74c3c}',
'.sk-kep .b-ok{background:#cff4f2;color:#0a7a7d}.sk-kep .b-w{background:#fdefd0;color:#c07800}.sk-kep .b-bad{background:#fad5d0;color:#ae2012}',
'/* Charts */',
'.csec{background:var(--sf);border:1px solid var(--br);border-radius:6px;padding:10px 12px;margin-bottom:8px;box-shadow:var(--sh)}',
'.cth{font-family:\'Space Mono\',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--td);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}',
'canvas{display:block;width:100%!important}',
'/* Heatmap */',
'.hms{background:var(--sf);border:1px solid var(--br);border-radius:6px;padding:10px 12px;margin-bottom:8px;box-shadow:var(--sh);overflow-x:auto}',
'.hmg{display:grid;grid-template-columns:22px repeat(24,minmax(8px,1fr));gap:0;margin-top:4px}',
'.hmc{height:10px;border-radius:0;background:var(--br);cursor:default;position:relative}',
'.hhl{font-family:\'Space Mono\',monospace;font-size:6px;color:var(--td);text-align:center;line-height:10px}',
'.hdl{font-family:\'Space Mono\',monospace;font-size:6px;color:var(--td);line-height:10px;white-space:nowrap}',
'.hleg{display:flex;align-items:center;gap:5px;margin-top:5px;font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td)}',
'.hlsc{display:flex;gap:2px}.hlc{width:12px;height:8px;border-radius:1px}',
'/* Table */',
'.tsec{background:var(--sf);border:1px solid var(--br);border-radius:6px;padding:8px 10px;margin-bottom:8px;box-shadow:var(--sh)}',
'.tfilter{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap}',
'.tscroll{max-height:320px;overflow-y:auto;overflow-x:auto}',
'.tscroll::-webkit-scrollbar{width:4px}',
'.tscroll::-webkit-scrollbar-thumb{background:var(--ad);border-radius:2px}',
'table{width:100%;border-collapse:collapse;font-family:\'Space Mono\',monospace;font-size:10px;white-space:nowrap}',
'th{text-align:left;padding:3px 4px;color:var(--td);font-size:9px;letter-spacing:.5px;text-transform:uppercase;border-bottom:1px solid var(--br);position:sticky;top:0;background:var(--sf)}',
'th.grp{color:var(--ac);border-bottom:none;padding-bottom:1px}',
'th.grp2{color:var(--bl);border-bottom:none;padding-bottom:1px}',
'th.narrow{width:32px}',
'td{padding:3px 4px;border-bottom:1px solid var(--br);color:var(--tx);font-size:10px}',
'tr:last-child td{border-bottom:none}',
'tr.drop td{color:var(--rd);opacity:.8}',
'tr.hi td{color:var(--am);opacity:.9}',
'tr.cf-drop td{color:var(--am);opacity:.85}',
'/* Footer */',
'footer{text-align:center;padding:14px 0 4px;font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td);letter-spacing:.5px;border-top:1px solid var(--br)}',
'footer a{color:var(--td);text-decoration:none}footer a:hover{color:var(--ac)}',
'/* Responsive */',
'@media(max-width:600px){',
'  .kpi-grid{grid-template-columns:1fr 1fr}',
'  .rcard{flex:0 0 118px}',
'  .hdr-time{font-size:11px}',
'  .hmg{grid-template-columns:22px repeat(24,minmax(6px,1fr))}',
'}',
'</style>',
'</head>',
'<body class="%%SKIN_CLASS%%">',
'<div class="app">',
'',
'<header>',
'  <div class="logo" id="btnSkin">',
'    <h1>NetWatch</h1><span class="skname" id="skinName">%%SKIN_NAME%%</span>',
'  </div>',
'  <div class="hdr-time" id="clock"></div>',
'</header>',
'',
'<div class="actions">',
'  <div class="pill" id="pill"><div class="dot"></div><span id="pillTxt">LOADING</span></div>',
'  <button class="btn-sync" id="btnSync" title="Resync">&#8635;</button>',
'  <button class="btn go" id="bTest">&#9654; Test Now</button>',
'  <button class="btn" id="bAuto">&#9201; Auto</button>',
'  <button class="btn-gear" id="btnGear" title="Settings">&#9881;</button>',
'</div>',
'',
'<div class="spanel" id="spanel">',
'  <!-- L1: view + source - single line -->',
'  <div class="sp-row" style="flex-wrap:nowrap;overflow-x:auto">',
'    <span class="slbl">View</span>',
'    <div class="bgrp">',
'      <button class="btn on" id="b24">24h</button>',
'      <button class="btn" id="b7">7d</button>',
'      <button class="btn" id="b30">30d</button>',
'    </div>',
'    <div class="bgrp" style="margin-left:4px">',
'      <button class="btn on" id="vBoth">Both</button>',
'      <button class="btn" id="vOokla">Ookla</button>',
'      <button class="btn" id="vCF">CF</button>',
'    </div>',
'  </div>',
'  <!-- L2: thresholds -->',
'  <div class="sp-row">',
'    <span class="slbl">Min</span>',
'    <input class="ci" id="tDl" type="number" value="5" max="999" title="Min DL Mbps">',
'    <span style="font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td)">Mbps</span>',
'    <input class="ci" id="tPing" type="number" value="100" max="999" title="Max ping ms">',
'    <span style="font-family:\'Space Mono\',monospace;font-size:10px;color:var(--td)">ms</span>',
'    <button class="btn go" id="btnApply">&#10003;</button>',
'  </div>',
'  <!-- L3: test interval + pause -->',
'  <div class="sp-row">',
'    <span class="slbl">Test</span>',
'    <div class="bgrp">',
'      <button class="btn" id="int5">5m</button>',
'      <button class="btn" id="int30">30m</button>',
'      <button class="btn" id="int60">1h</button>',
'      <button class="btn" id="int180">3h</button>',
'      <button class="btn" id="int360">6h</button>',
'    </div>',
'    <span class="burst-note" id="burstNote" style="display:none"></span>',
'    <button class="btn warn" id="btnPause">&#9646;&#9646; Pause</button>',
'  </div>',
'  <!-- L4: status -->',
'  <div class="sp-row">',
'    <div class="sp-status">',
'      <span id="stOokla"><span class="dot-na">&#9679;</span> Ookla --</span>',
'      <span id="stCF"><span class="dot-na">&#9679;</span> CF --</span>',
'      <span id="stNext"></span>',
'    </div>',
'  </div>',
'  <!-- L5: updates + access toggle on same line -->',
'  <div class="sp-row">',
'    <button class="btn" id="btnCheck">Check updates</button>',
'    <button class="btn go" id="btnInstall" style="display:none">Install &amp; Restart</button>',
'    <span id="stVer" style="font-size:9px;color:var(--td)"></span>',
'    <span style="flex:1"></span>',
'    <span class="slbl">Access</span>',
'    <button class="btn sec" id="btnTailOnly">LAN + Tail</button>',
'  </div>',
'  <!-- L6: messages + tailscale IP input -->',
'  <div class="sp-row">',
'    <span id="spMsg" class="sp-msg"></span>',
'    <span style="flex:1"></span>',
'    <span style="font-family:\'Space Mono\',monospace;font-size:9px;color:var(--td)">Tail IP:</span>',
'    <input class="ci wide" id="tailIpInput" type="text" placeholder="100.x.x.x" title="Your Tailscale IP">',
'    <button class="btn go" id="btnSaveTailIp">&#10003;</button>',
'  </div>',
'</div>',
'',
'<div class="kpi-grid" id="kpiGrid">',
'  <div class="kpi-pair" id="pairDl">',
'    <div class="kpi" style="--kc:var(--ac)"><div class="kl">Ookla Download</div><div class="kv" id="kDl">--<span class="ku">Mbps</span></div><div class="ks-time" id="kTime">--</div></div>',
'    <div class="kpi" style="--kc:var(--bl)"><div class="kl">CF Download</div><div class="kv" id="kCfDl" style="color:var(--bl)">--<span class="ku">Mbps</span></div><div class="ks">Cloudflare</div></div>',
'  </div>',
'  <div class="kpi-pair" id="pairUl">',
'    <div class="kpi" style="--kc:var(--ac)"><div class="kl">Ookla Upload</div><div class="kv" id="kUl" style="color:var(--ac)">--<span class="ku">Mbps</span></div><div class="ks" id="kSrv">--</div></div>',
'    <div class="kpi" style="--kc:var(--bl)"><div class="kl">CF Upload</div><div class="kv" id="kCfUl" style="color:var(--bl)">--<span class="ku">Mbps</span></div><div class="ks" id="kCfUlS">--</div></div>',
'  </div>',
'  <div class="kpi-pair" id="pairPing">',
'    <div class="kpi" style="--kc:var(--am)"><div class="kl">Ookla Ping</div><div class="kv" id="kPing" style="color:var(--am)">--<span class="ku">ms</span></div><div class="ks" id="kPingS">--</div></div>',
'    <div class="kpi" style="--kc:var(--am)"><div class="kl">CF Ping</div><div class="kv" id="kCfPing" style="color:var(--am)">--<span class="ku">ms</span></div><div class="ks" id="kCfJitter">--</div></div>',
'  </div>',
'  <div class="kpi-pair" id="pairStab">',
'    <div class="kpi" style="--kc:var(--ac)"><div class="kl">Stability <span id="wLbl" style="color:var(--ac)">(24h)</span></div><div class="kv" id="kStab" style="color:var(--ac)">--<span class="ku">%</span></div><div class="sbo"><div class="sbi" id="sBar" style="width:0%"></div></div><div class="ks" id="kStabS">--</div></div>',
'    <div class="kpi" style="--kc:var(--bl)"><div class="kl">CF Stability</div><div class="kv" id="kCfStab" style="color:var(--bl)">--<span class="ku">%</span></div><div class="sbo"><div class="sbi" id="sCfBar" style="width:0%"></div></div><div class="ks" id="kCfStabS">--</div></div>',
'  </div>',
'  <div class="kpi-pair" id="pairAvg">',
'    <div class="kpi"><div class="kl">Avg Download</div><div class="kv" id="kAvg" style="color:var(--ad)">--<span class="ku">Mbps</span></div><div class="ks" id="kRange">--</div></div>',
'    <div class="kpi"><div class="kl">CF vs Ookla DL</div><div class="kv" id="kCfDelta" style="color:var(--td)">--<span class="ku">Mbps</span></div><div class="ks" id="kCfDeltaS">last-mile</div></div>',
'  </div>',
'  <div class="kpi-pair" id="pairDrop">',
'    <div class="kpi"><div class="kl">Dropout Rate</div><div class="kv" id="kDrop" style="color:var(--rd)">--<span class="ku">%</span></div><div class="ks" id="kDropS">--</div></div>',
'    <div class="kpi"><div class="kl">CF Dropout</div><div class="kv" id="kCfDrop" style="color:var(--rd)">--<span class="ku">%</span></div><div class="ks" id="kCfDropS">--</div></div>',
'  </div>',
'</div>',
'',
'<div class="rec-wrap">',
'  <div class="rec-lbl">Recent Tests <span id="rCnt" style="color:var(--td)"></span></div>',
'  <div class="rec-scroll" id="recScroll"></div>',
'</div>',
'',
'<div class="csec">',
'  <div class="cth"><span id="chartDlTitle">Download / Upload - Mbps</span><span id="cRange" style="font-size:9px;color:var(--td)"></span></div>',
'  <canvas id="cMain" style="height:110px!important;max-height:110px"></canvas>',
'</div>',
'<div class="csec">',
'  <div class="cth"><span id="chartPingTitle">Ping - ms</span></div>',
'  <canvas id="cPing" style="height:65px!important;max-height:65px"></canvas>',
'</div>',
'',
'<div class="hms">',
'  <div class="cth"><span>Dropout Heatmap - 14d x 24h (Ookla)</span><span style="font-size:9px;color:var(--td)">hover = value</span></div>',
'  <div class="hmg" id="hmg"></div>',
'  <div class="hleg">LOW<div class="hlsc" id="hls"></div>HIGH</div>',
'</div>',
'',
'<div class="tsec">',
'  <div class="cth">',
'    <span>Test History &mdash; <span style="color:var(--td)">Filter</span></span>',
'    <span id="tCnt" style="color:var(--td)"></span>',
'  </div>',
'  <div class="tfilter">',
'    <button class="btn on" id="fAll">All</button>',
'    <button class="btn" id="fDrop">Drops</button>',
'    <button class="btn" id="fHiPing">Hi Ping</button>',
'    <button class="btn" id="fOk">OK</button>',
'    <button class="btn" id="fPartial">Partial</button>',
'  </div>',
'  <div class="tscroll">',
'    <table>',
'      <thead>',
'        <tr>',
'          <th rowspan="2" style="vertical-align:bottom">Time</th>',
'          <th colspan="3" class="grp">Ookla</th>',
'          <th colspan="3" class="grp2">Cloudflare</th>',
'          <th rowspan="2" style="vertical-align:bottom">Stat</th>',
'        </tr>',
'        <tr>',
'          <th>DL</th><th>UL</th><th class="narrow">ms</th>',
'          <th>DL</th><th>UL</th><th class="narrow">ms</th>',
'        </tr>',
'      </thead>',
'      <tbody id="tbody"></tbody>',
'    </table>',
'  </div>',
'</div>',
'',
'<footer>',
'  NetWatch v1.3 &nbsp;|&nbsp;',
'  <a href="https://ced.watch" target="_blank">ced&#183;watch</a>',
'  &nbsp;|&nbsp;',
'  <a href="https://github.com/cedwatch" target="_blank">GitHub</a>',
'</footer>',
'</div>',
'',
'<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>',
'<script>',
'var SKINS=[{cls:"sk-kampot",name:"Kampot"},{cls:"sk-mekong",name:"Mekong"},{cls:"sk-kep",name:"Kep"}];',
'var skinIdx=%%SKIN_IDX%%;',
'var all=[],view=[],winH=24,tDl=5,tPing=100,dataView="both",tFilter="all";',
'var cM=null,cP=null,autoTimer=null,autoOn=false,pillState="";',
'',
'function tick(){document.getElementById("clock").textContent=new Date().toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});}',
'setInterval(tick,1000);tick();',
'',
'function applySkin(idx){',
'  skinIdx=idx%SKINS.length;',
'  var s=SKINS[skinIdx];',
'  document.body.className=s.cls;',
'  document.getElementById("skinName").textContent=s.name;',
'  fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({skin:skinIdx})});',
'  if(all.length) render();',
'}',
'document.getElementById("btnSkin").addEventListener("click",function(){applySkin(skinIdx+1);});',
'',
'document.getElementById("btnGear").addEventListener("click",function(){',
'  document.getElementById("spanel").classList.toggle("open");',
'  document.getElementById("btnGear").classList.toggle("on");',
'});',
'',
'var API=window.location.origin;',
'',
'function setP(cls,txt){',
'  pillState=cls;',
'  var p=document.getElementById("pill");',
'  p.className="pill "+cls;',
'  document.getElementById("pillTxt").textContent=txt;',
'}',
'',
'function showMsg(txt,color){',
'  var el=document.getElementById("spMsg");',
'  el.textContent=txt;',
'  el.style.color=color||"var(--td)";',
'  el.className=txt?"sp-msg show":"sp-msg";',
'}',
'',
'function fetchData(){',
'  setP("live","LOADING");',
'  fetch(API+"/api/speedtests?hours=2160")',
'    .then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json();})',
'    .then(function(j){',
'      all=(Array.isArray(j)?j:[]).map(norm).filter(Boolean).sort(function(a,b){return a.ts-b.ts;});',
'      setP("live","LIVE");',
'      applyW();',
'      fetchStatus();',
'    })',
'    .catch(function(e){setP("err",e.message.slice(0,20));});',
'}',
'',
'function norm(t){',
'  if(!t||!t.ts) return null;',
'  return{',
'    ts:t.ts,created:t.created,status:t.status||"ok",',
'    dl:t.ookla?t.ookla.dl:-1, ul:t.ookla?t.ookla.ul:-1,',
'    ping:t.ookla?t.ookla.ping:-1, jitter:t.ookla?t.ookla.jitter:0,',
'    server:t.ookla?t.ookla.server:"",',
'    cfDl:t.cf?t.cf.dl:-1, cfUl:t.cf?t.cf.ul:-1,',
'    cfPing:t.cf?t.cf.ping:-1, cfJitter:t.cf?t.cf.jitter:0,',
'  };',
'}',
'',
'function fetchStatus(){',
'  fetch(API+"/api/status").then(function(r){return r.json();})',
'  .then(function(s){',
'    var el=document.getElementById("stOokla");',
'    el.innerHTML=(s.ooklaPresent?\'<span class="dot-ok">&#9679;</span>\':\'<span class="dot-fail">&#9679;</span>\')+\' Ookla \'+(s.ooklaPresent?"OK":"MISSING");',
'    var elcf=document.getElementById("stCF");',
'    elcf.innerHTML=(s.cfOk?\'<span class="dot-ok">&#9679;</span>\':\'<span class="dot-na">&#9679;</span>\')+\' CF \'+(s.cfOk?"OK":"--");',
'    document.getElementById("stVer").textContent="v"+s.version;',
'    var bn=document.getElementById("burstNote");',
'    if(s.burstActive){bn.style.display="";bn.textContent="burst "+s.burstCount+"/"+s.burstTotal+" then 30m";}',
'    else{bn.style.display="none";}',
'    if(pillState!=="err"){',
'      var nx=document.getElementById("stNext");',
'      if(s.paused){nx.textContent="PAUSED";document.getElementById("btnPause").textContent="Resume";document.getElementById("btnPause").classList.add("on");}',
'      else if(s.nextRun){var dt=new Date(s.nextRun);nx.textContent="Next: "+dt.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});document.getElementById("btnPause").textContent="\\u23F8 Pause";document.getElementById("btnPause").classList.remove("on");}',
'    }',
'    // Access toggle state',
'    var btnT=document.getElementById("btnTailOnly");',
'    var ipInp=document.getElementById("tailIpInput");',
'    if(s.tailscaleOnly){',
'      btnT.textContent="Tailscale Only";btnT.classList.add("on");',
'      var msg=s.tailscaleOk?("Tail IP: "+s.tailscaleIP+" - LAN blocked"):"! No valid Tail IP set - fallback to LAN";',
'      showMsg(msg, s.tailscaleOk?"var(--bl)":"var(--am)");',
'    } else {',
'      btnT.textContent="LAN + Tail";btnT.classList.remove("on");',
'      var msg2=s.tailscaleOk?("Tail IP: "+s.tailscaleIP+" - LAN open"):"Tail IP not set (LAN open)";',
'      showMsg(msg2,"var(--td)");',
'    }',
'    if(s.tailscaleIP) ipInp.value=s.tailscaleIP;',
'  }).catch(function(){});',
'  fetch(API+"/api/config").then(function(r){return r.json();})',
'  .then(function(c){',
'    tDl=c.threshDl||tDl; tPing=c.threshPing||tPing;',
'    document.getElementById("tDl").value=tDl;',
'    document.getElementById("tPing").value=tPing;',
'    highlightInterval(c.interval);',
'  }).catch(function(){});',
'}',
'',
'function setW(h){',
'  winH=h;',
'  ["b24","b7","b30"].forEach(function(id){document.getElementById(id).classList.remove("on");});',
'  document.getElementById(h===24?"b24":h===168?"b7":"b30").classList.add("on");',
'  document.getElementById("wLbl").textContent=h===24?"(24h)":h===168?"(7d)":"(30d)";',
'  applyW();',
'}',
'function applyW(){',
'  var cut=Date.now()-winH*3600000;',
'  view=all.filter(function(d){return d.ts>=cut;});',
'  if(view.length) render();',
'}',
'',
'function applyThr(){',
'  tDl=parseFloat(document.getElementById("tDl").value)||5;',
'  tPing=parseFloat(document.getElementById("tPing").value)||100;',
'  fetch(API+"/api/config",{method:"POST",headers:{"Content-Type":"application/json"},',
'    body:JSON.stringify({threshDl:tDl,threshPing:tPing})});',
'  applyW();',
'}',
'',
'function setDataView(v){',
'  dataView=v;',
'  ["vBoth","vOokla","vCF"].forEach(function(id){document.getElementById(id).classList.remove("on");});',
'  document.getElementById(v==="both"?"vBoth":v==="ookla"?"vOokla":"vCF").classList.add("on");',
'  var showO=v==="both"||v==="ookla";',
'  var showC=v==="both"||v==="cf";',
'  var pairs=["pairDl","pairUl","pairPing","pairStab","pairAvg","pairDrop"];',
'  pairs.forEach(function(pid){',
'    var kids=document.getElementById(pid).children;',
'    if(kids[0]) kids[0].style.display=showO?"":"none";',
'    if(kids[1]) kids[1].style.display=showC?"":"none";',
'  });',
'  if(all.length) render();',
'}',
'',
'function toggleAuto(){',
'  autoOn=!autoOn;',
'  var b=document.getElementById("bAuto");',
'  b.classList.toggle("on",autoOn);',
'  b.textContent=autoOn?"\\u23F1 ON":"\\u23F1 Auto";',
'  clearInterval(autoTimer);',
'  if(autoOn){fetchData();autoTimer=setInterval(fetchData,60000);}',
'}',
'',
'function triggerTest(){',
'  var btn=document.getElementById("bTest");',
'  btn.textContent="...";btn.disabled=true;',
'  setP("run","TESTING");',
'  fetch(API+"/api/speedtests/run",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})',
'    .then(function(r){return r.json().then(function(j){return{r:r,j:j};});})',
'    .then(function(x){',
'      if(x.r.ok){setTimeout(function(){fetchData();btn.textContent="\\u25B6 Test Now";btn.disabled=false;},95000);}',
'      else{btn.textContent="\\u25B6 Test Now";btn.disabled=false;setP("live","LIVE");alert(x.j.message||"Error");}',
'    })',
'    .catch(function(e){btn.textContent="\\u25B6 Test Now";btn.disabled=false;alert(e.message);});',
'}',
'',
'function setInterval_(min){',
'  fetch(API+"/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({interval:min})})',
'    .then(function(){highlightInterval(min);fetchStatus();}).catch(function(e){alert(e.message);});',
'}',
'function highlightInterval(min){',
'  var map={5:"int5",30:"int30",60:"int60",180:"int180",360:"int360"};',
'  ["int5","int30","int60","int180","int360"].forEach(function(id){document.getElementById(id).classList.remove("on");});',
'  if(map[min]) document.getElementById(map[min]).classList.add("on");',
'}',
'',
'function togglePause(){',
'  var paused=document.getElementById("btnPause").classList.contains("on");',
'  fetch(API+"/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({paused:!paused})})',
'    .then(function(){fetchStatus();}).catch(function(e){alert(e.message);});',
'}',
'',
'function toggleTailOnly(){',
'  var current=document.getElementById("btnTailOnly").classList.contains("on");',
'  fetch(API+"/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tailscaleOnly:!current})})',
'  .then(function(r){return r.json();})',
'  .then(function(){',
'    fetchStatus();',
'    if(!current){',
'      setTimeout(function(){',
'        if(confirm("Tailscale Only activated. NetWatch needs to restart to rebind. Restart now?")){',
'          fetch(API+"/api/restart",{method:"POST"}).catch(function(){});',
'        }',
'      },300);',
'    }',
'  }).catch(function(e){alert(e.message);});',
'}',
'',
'function saveTailIp(){',
'  var ip=document.getElementById("tailIpInput").value.trim();',
'  if(ip && !ip.match(/^100\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/)){',
'    showMsg("! Invalid IP - must be 100.x.x.x","var(--rd)"); return;',
'  }',
'  fetch(API+"/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tailscaleIP:ip})})',
'  .then(function(r){return r.json();})',
'  .then(function(){showMsg(ip?"Tail IP saved: "+ip:"Tail IP cleared","var(--ac)");fetchStatus();})',
'  .catch(function(e){showMsg("Error: "+e.message,"var(--rd)");});',
'}',
'',
'function checkUpdate(){',
'  showMsg("Checking for updates...","var(--td)");',
'  fetch(API+"/api/update/check").then(function(r){return r.json();})',
'  .then(function(d){',
'    if(d.newer){',
'      showMsg("v"+d.latest+" available!","var(--ac)");',
'      document.getElementById("btnInstall").style.display="";',
'    } else {',
'      showMsg("Up to date (v"+d.current+")","var(--td)");',
'      document.getElementById("btnInstall").style.display="none";',
'    }',
'  }).catch(function(e){showMsg("Error: "+e.message,"var(--rd)");});',
'}',
'function doInstall(){',
'  if(!confirm("Install update and restart NetWatch?")) return;',
'  showMsg("Installing...","var(--am)");',
'  fetch(API+"/api/update/install",{method:"POST"}).then(function(r){return r.json();})',
'  .then(function(d){showMsg(d.message,"var(--ac)");})',
'  .catch(function(e){showMsg("Error: "+e.message,"var(--rd)");});',
'}',
'',
'function render(){renderKPIs();renderRecent();renderMain();renderPing();renderHeatmap();renderTable();}',
'',
'function renderKPIs(){',
'  if(!view.length) return;',
'  var last=view[view.length-1];',
'  var val=view.filter(function(d){return d.dl>=0&&d.ping>0;});',
'  var ok=val.filter(function(d){return d.dl>=tDl&&d.ping<=tPing;});',
'  var drops=val.filter(function(d){return d.dl>=0&&d.dl<tDl;});',
'  var stab=val.length?Math.round(ok.length/val.length*100):0;',
'  var dropP=val.length?Math.round(drops.length/val.length*100):0;',
'  var avg=val.length?(val.reduce(function(a,d){return a+d.dl;},0)/val.length).toFixed(1):0;',
'  var dls=val.filter(function(d){return d.dl>0;});',
'  var maxD=dls.length?Math.max.apply(null,dls.map(function(d){return d.dl;})).toFixed(1):"--";',
'  var minD=dls.length?Math.min.apply(null,dls.map(function(d){return d.dl;})).toFixed(1):"--";',
'  S("kDl",(last.dl<0?"--":last.dl.toFixed(1))+"<span class=\\"ku\\">Mbps</span>");',
'  S("kUl",(last.ul<0?"--":last.ul.toFixed(1))+"<span class=\\"ku\\">Mbps</span>");',
'  S("kPing",(last.ping<0?"--":Math.round(last.ping))+"<span class=\\"ku\\">ms</span>");',
'  T("kTime",fmt(last.created)); T("kSrv",last.server||"--");',
'  T("kPingS",last.ping>tPing?"! High":last.ping>0?"OK":"--");',
'  var sc=stab>80?"var(--ac)":stab>50?"var(--am)":"var(--rd)";',
'  S("kStab",stab+"<span class=\\"ku\\">%</span>"); G("kStab").style.color=sc;',
'  G("sBar").style.cssText="width:"+stab+"%;background:"+sc;',
'  T("kStabS",ok.length+"/"+val.length+" OK");',
'  S("kAvg",avg+"<span class=\\"ku\\">Mbps</span>"); T("kRange","min"+minD+" max"+maxD);',
'  S("kDrop",dropP+"<span class=\\"ku\\">%</span>");',
'  G("kDrop").style.color=dropP>30?"var(--rd)":dropP>15?"var(--am)":"var(--ac)";',
'  T("kDropS",drops.length+" events");',
'  var hasCF=view.some(function(d){return d.cfDl>=0;});',
'  if(!hasCF) return;',
'  var valC=view.filter(function(d){return d.cfDl>=0&&d.cfPing>0;});',
'  var okC=valC.filter(function(d){return d.cfDl>=tDl&&d.cfPing<=tPing;});',
'  var dropsC=valC.filter(function(d){return d.cfDl>=0&&d.cfDl<tDl;});',
'  var stabC=valC.length?Math.round(okC.length/valC.length*100):0;',
'  var dropPC=valC.length?Math.round(dropsC.length/valC.length*100):0;',
'  S("kCfDl",(last.cfDl<0?"--":last.cfDl.toFixed(1))+"<span class=\\"ku\\">Mbps</span>");',
'  S("kCfUl",(last.cfUl<0?"--":last.cfUl.toFixed(1))+"<span class=\\"ku\\">Mbps</span>");',
'  S("kCfPing",(last.cfPing<0?"--":Math.round(last.cfPing))+"<span class=\\"ku\\">ms</span>");',
'  T("kCfJitter",last.cfJitter?"jitter "+last.cfJitter+"ms":"--");',
'  T("kCfUlS","--");',
'  var delta=last.dl>=0&&last.cfDl>=0?parseFloat((last.cfDl-last.dl).toFixed(1)):null;',
'  S("kCfDelta",(delta===null?"--":(delta>=0?"+":"")+delta)+"<span class=\\"ku\\">Mbps</span>");',
'  G("kCfDelta").style.color=delta===null?"var(--td)":delta>0?"var(--ac)":"var(--am)";',
'  T("kCfDeltaS",delta===null?"--":delta>=0?"CF faster":"Ookla faster");',
'  var scC=stabC>80?"var(--bl)":stabC>50?"var(--am)":"var(--rd)";',
'  S("kCfStab",stabC+"<span class=\\"ku\\">%</span>"); G("kCfStab").style.color=scC;',
'  G("sCfBar").style.cssText="width:"+stabC+"%;background:"+scC;',
'  T("kCfStabS",okC.length+"/"+valC.length+" OK");',
'  S("kCfDrop",dropPC+"<span class=\\"ku\\">%</span>");',
'  G("kCfDrop").style.color=dropPC>30?"var(--rd)":dropPC>15?"var(--am)":"var(--ac)";',
'  T("kCfDropS",dropsC.length+" events");',
'}',
'',
'function renderRecent(){',
'  var sc=G("recScroll"); sc.innerHTML="";',
'  var recent=all.slice().reverse().slice(0,24);',
'  T("rCnt","- "+recent.length+" latest");',
'  recent.forEach(function(d){',
'    var fail=d.dl<0, drop=!fail&&d.dl<tDl;',
'    var card=document.createElement("div"); card.className="rcard";',
'    card.style.setProperty("--rc",fail||drop?"var(--rd)":"var(--ac)");',
'    var badge=d.status==="partial"?\'<span class="badge b-w">PART</span>\':',
'      fail?\'<span class="badge b-bad">FAIL</span>\':',
'      drop?\'<span class="badge b-w">DROP</span>\':',
'      \'<span class="badge b-ok">OK</span>\';',
'    var ooklaUl=d.ul>=0?\'<div class="rc-sub">UL \'+d.ul.toFixed(1)+\' M</div>\':"";',
'    var cfRow=d.cfDl>=0?\'<div class="rc-row"><span class="rc-lbl">CF</span><span class="rc-val2 \'+(d.cfDl<tDl?"bad":"")+\'">\'+d.cfDl.toFixed(1)+\'<span class="rc-u"> M</span></span></div>\':"";',
'    var cfUlRow=d.cfUl>=0?\'<div class="rc-sub2">UL \'+d.cfUl.toFixed(1)+\' M</div>\':"";',
'    card.innerHTML=',
'      \'<div class="rc-time">\'+fmtS2(d.created)+\'</div>\'+',
'      \'<div class="rc-row"><span class="rc-lbl">Ookla</span><span class="rc-val \'+(fail||drop?"bad":"")+\'">\'+',
'        (fail?"--":d.dl.toFixed(1))+\'<span class="rc-u"> M</span></span></div>\'+',
'      ooklaUl+cfRow+cfUlRow+',
'      \'<div class="rc-ping">ping \'+(d.ping<0?"--":Math.round(d.ping))+"ms</div>"+',
'      badge;',
'    sc.appendChild(card);',
'  });',
'}',
'',
'function getCS(){return getComputedStyle(document.body);}',
'',
'function renderMain(){',
'  var ctx=G("cMain").getContext("2d");',
'  if(cM){cM.destroy();cM=null;}',
'  var cs=getCS();',
'  var green=cs.getPropertyValue("--ac").trim();',
'  var blue=cs.getPropertyValue("--bl").trim();',
'  var red=cs.getPropertyValue("--rd").trim();',
'  var td=cs.getPropertyValue("--td").trim();',
'  var br=cs.getPropertyValue("--br").trim();',
'  var sf=cs.getPropertyValue("--sf").trim();',
'  var tx=cs.getPropertyValue("--tx").trim();',
'  var showO=dataView==="both"||dataView==="ookla";',
'  var showC=dataView==="both"||dataView==="cf";',
'  var ds=[];',
'  if(showO){',
'    ds.push({label:"Ookla DL",data:view.map(function(d){return d.dl<0?null:d.dl;}),',
'      borderColor:green,fill:!showC,',
'      backgroundColor:!showC?function(c){var g=c.chart.ctx.createLinearGradient(0,0,0,110);g.addColorStop(0,ra(green,.14));g.addColorStop(1,ra(green,0));return g;}:"transparent",',
'      tension:.3,borderWidth:1.5,pointRadius:view.length>150?0:1.5,pointHoverRadius:3});',
'    ds.push({label:"Ookla UL",data:view.map(function(d){return d.ul<0?null:d.ul;}),',
'      borderColor:ra(green,.5),fill:false,tension:.3,borderWidth:1,pointRadius:0,pointHoverRadius:3,borderDash:[2,3]});',
'  }',
'  if(showC){',
'    ds.push({label:"CF DL",data:view.map(function(d){return d.cfDl<0?null:d.cfDl;}),',
'      borderColor:blue,fill:false,tension:.3,borderWidth:1.5,pointRadius:0,pointHoverRadius:3});',
'    ds.push({label:"CF UL",data:view.map(function(d){return d.cfUl<0?null:d.cfUl;}),',
'      borderColor:ra(blue,.5),fill:false,tension:.3,borderWidth:1,pointRadius:0,pointHoverRadius:3,borderDash:[2,3]});',
'  }',
'  ds.push({label:"Min",data:view.map(function(){return tDl;}),',
'    borderColor:ra(red,.35),borderDash:[4,4],borderWidth:1,pointRadius:0,fill:false});',
'  cM=new Chart(ctx,{type:"line",data:{labels:view.map(function(d){return fmtS(d.created);}),datasets:ds},options:cOpts("Mbps",td,br,sf,green,tx)});',
'  T("cRange",fmtS(view.length?view[0].created:"")+\' -> \'+fmtS(view.length?view[view.length-1].created:""));',
'  T("chartDlTitle",showO&&showC?"DL/UL Mbps (green=Ookla blue=CF)":showO?"Ookla DL/UL - Mbps":"CF DL/UL - Mbps");',
'}',
'',
'function renderPing(){',
'  var ctx=G("cPing").getContext("2d");',
'  if(cP){cP.destroy();cP=null;}',
'  var cs=getCS();',
'  var amber=cs.getPropertyValue("--am").trim();',
'  var blue=cs.getPropertyValue("--bl").trim();',
'  var red=cs.getPropertyValue("--rd").trim();',
'  var td=cs.getPropertyValue("--td").trim();',
'  var br=cs.getPropertyValue("--br").trim();',
'  var sf=cs.getPropertyValue("--sf").trim();',
'  var tx=cs.getPropertyValue("--tx").trim();',
'  var showO=dataView==="both"||dataView==="ookla";',
'  var showC=dataView==="both"||dataView==="cf";',
'  var ds=[],vO=view.filter(function(d){return d.ping>0;}),vC=view.filter(function(d){return d.cfPing>0;});',
'  if(showO&&vO.length) ds.push({label:"Ookla",data:vO.map(function(d){return d.ping;}),',
'    borderColor:amber,fill:true,backgroundColor:ra(amber,.06),tension:.2,borderWidth:1.5,pointRadius:0,pointHoverRadius:3});',
'  if(showC&&vC.length) ds.push({label:"CF",data:vC.map(function(d){return d.cfPing;}),',
'    borderColor:blue,fill:false,tension:.2,borderWidth:1,pointRadius:0,pointHoverRadius:3});',
'  ds.push({label:"Max",data:view.map(function(){return tPing;}),',
'    borderColor:ra(red,.3),borderDash:[4,4],borderWidth:1,pointRadius:0,fill:false});',
'  var labels=showO&&vO.length?vO.map(function(d){return fmtS(d.created);}):vC.map(function(d){return fmtS(d.created);});',
'  cP=new Chart(ctx,{type:"line",data:{labels:labels,datasets:ds},options:cOpts("ms",td,br,sf,amber,tx)});',
'  T("chartPingTitle",showO&&showC?"Ping ms (orange=Ookla blue=CF)":showO?"Ookla Ping - ms":"CF Ping - ms");',
'}',
'',
'function cOpts(yT,td,br,sf,ac,tx){',
'  return{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},',
'    plugins:{',
'      legend:{labels:{color:td,font:{family:"Space Mono",size:9},boxWidth:9,padding:8}},',
'      tooltip:{backgroundColor:sf,borderColor:br,borderWidth:1,titleColor:ac,bodyColor:tx,',
'        titleFont:{family:"Space Mono",size:9},bodyFont:{family:"Space Mono",size:9}},',
'    },',
'    scales:{',
'      x:{ticks:{color:td,font:{family:"Space Mono",size:8},maxTicksLimit:10,maxRotation:0},grid:{color:br+"80"}},',
'      y:{min:0,ticks:{color:td,font:{family:"Space Mono",size:8}},grid:{color:br+"80"},',
'        title:{display:true,text:yT,color:td,font:{family:"Space Mono",size:8}}},',
'    }',
'  };',
'}',
'',
'(function(){',
'  var tt=document.createElement("div");tt.id="hmTip";',
'  tt.style.cssText="position:fixed;display:none;background:var(--sf);border:1px solid var(--br);border-radius:4px;padding:4px 8px;font-family:Space Mono,monospace;font-size:9px;color:var(--tx);z-index:100;pointer-events:none;white-space:nowrap";',
'  document.body.appendChild(tt);',
'})();',
'function showHmTip(e,txt){',
'  var tt=G("hmTip");tt.textContent=txt;tt.style.display="block";',
'  var x=(e.touches?e.touches[0].clientX:e.clientX),y=(e.touches?e.touches[0].clientY:e.clientY);',
'  tt.style.left=(x+12)+"px";tt.style.top=(y-32)+"px";',
'}',
'function hideHmTip(){G("hmTip").style.display="none";}',
'',
'function renderHeatmap(){',
'  var grid=G("hmg"); grid.innerHTML="";',
'  var now=Date.now(),days=14,bkt={};',
'  all.forEach(function(d){',
'    var ago=Math.floor((now-d.ts)/86400000);',
'    if(ago>=days) return;',
'    var h=new Date(d.ts).getHours(),k=ago+"-"+h;',
'    if(!bkt[k]) bkt[k]=[];',
'    bkt[k].push(d.dl>=0?d.dl:0);',
'  });',
'  var flat=[];Object.keys(bkt).forEach(function(k){flat=flat.concat(bkt[k]);});',
'  var maxV=flat.length?Math.max.apply(null,flat):50;',
'  var corner=document.createElement("div");corner.className="hdl";grid.appendChild(corner);',
'  for(var h=0;h<24;h++){var e=document.createElement("div");e.className="hhl";e.textContent=h%6===0?h+"h":"";grid.appendChild(e);}',
'  for(var day=0;day<days;day++){',
'    var dl=document.createElement("div");dl.className="hdl";',
'    var dt=new Date(now-day*86400000);dl.textContent=(dt.getMonth()+1)+"/"+(dt.getDate());',
'    grid.appendChild(dl);',
'    for(var hr=0;hr<24;hr++){',
'      var k=day+"-"+hr,vals=bkt[k]||[];',
'      var avg=vals.length?vals.reduce(function(a,b){return a+b;},0)/vals.length:null;',
'      var cell=document.createElement("div");cell.className="hmc";',
'      var tipTxt=avg===null?(dLbl(day)+" "+hr+"h - no data"):(dLbl(day)+" "+hr+"h - "+avg.toFixed(1)+" Mbps ("+vals.length+")");',
'      cell.style.background=avg===null?"var(--br)":hCol(Math.min(avg/maxV,1),avg<tDl);',
'      (function(txt){',
'        cell.addEventListener("mouseover",function(e){showHmTip(e,txt);});',
'        cell.addEventListener("mousemove",function(e){showHmTip(e,txt);});',
'        cell.addEventListener("mouseout",hideHmTip);',
'        cell.addEventListener("touchstart",function(e){e.preventDefault();showHmTip(e,txt);},{passive:false});',
'        cell.addEventListener("touchend",function(){setTimeout(hideHmTip,1500);});',
'      })(tipTxt);',
'      grid.appendChild(cell);',
'    }',
'  }',
'  var ls=G("hls");ls.innerHTML="";',
'  for(var i=0;i<=8;i++){var lc=document.createElement("div");lc.className="hlc";lc.style.background=hCol(i/8,false);ls.appendChild(lc);}',
'}',
'function hCol(t,drop){',
'  if(drop) return "rgba(231,76,60,"+(0.18+t*0.52)+")";',
'  var s=SKINS[skinIdx].cls;',
'  if(s==="sk-kep") return "rgb("+(200-Math.round(t*155))+","+(225-Math.round(t*60))+","+(230-Math.round(t*80))+")";',
'  if(s==="sk-mekong") return "rgb("+(25+Math.round(t*110))+","+(18+Math.round(t*85))+",0)";',
'  return "rgb("+(7+Math.round(t*14))+","+(30+Math.round(t*175))+","+(10+Math.round(t*80))+")";',
'}',
'function dLbl(d){',
'  if(d===0) return "Today"; if(d===1) return "Yest.";',
'  var dt=new Date(Date.now()-d*86400000); return (dt.getMonth()+1)+"/"+(dt.getDate());',
'}',
'',
'function setFilter(f){',
'  tFilter=f;',
'  ["fAll","fDrop","fHiPing","fOk","fPartial"].forEach(function(id){document.getElementById(id).classList.remove("on");});',
'  document.getElementById(f==="all"?"fAll":f==="drop"?"fDrop":f==="hiping"?"fHiPing":f==="partial"?"fPartial":"fOk").classList.add("on");',
'  renderTable();',
'}',
'',
'function renderTable(){',
'  var tb=G("tbody"); tb.innerHTML="";',
'  var rows=all.slice().reverse();',
'  if(tFilter==="drop")    rows=rows.filter(function(d){return d.dl>=0&&d.dl<tDl;});',
'  if(tFilter==="hiping")  rows=rows.filter(function(d){return d.ping>tPing;});',
'  if(tFilter==="ok")      rows=rows.filter(function(d){return d.dl>=tDl&&d.ping<=tPing&&d.ping>0;});',
'  if(tFilter==="partial") rows=rows.filter(function(d){return d.status==="partial";});',
'  T("tCnt",rows.length+" tests");',
'  rows.forEach(function(d){',
'    var tr=document.createElement("tr");',
'    var fail=d.dl<0,drop=!fail&&d.dl<tDl,hiping=d.ping>tPing;',
'    var cfDrop=!fail&&!drop&&d.cfDl>=0&&d.cfDl<tDl;',
'    if(fail||drop) tr.className="drop"; else if(hiping) tr.className="hi"; else if(cfDrop) tr.className="cf-drop";',
'    var badge=d.status==="partial"?\'<span class="badge b-w">PART</span>\':',
'      fail?\'<span class="badge b-bad">FAIL</span>\':',
'      drop?\'<span class="badge b-w">DROP</span>\':',
'      hiping?\'<span class="badge b-w">PING</span>\':',
'      \'<span class="badge b-ok">OK</span>\';',
'    tr.innerHTML=',
'      "<td>"+fmt(d.created)+"</td>"+',
'      "<td style=\\"color:"+(fail||drop?"var(--rd)":"var(--ac)")+"\\">"+(fail?"--":d.dl.toFixed(2))+"</td>"+',
'      "<td>"+(fail?"--":d.ul.toFixed(2))+"</td>"+',
'      "<td>"+(d.ping<0?"--":Math.round(d.ping))+"</td>"+',
'      "<td style=\\"color:var(--bl)\\">"+(d.cfDl<0?"--":d.cfDl.toFixed(2))+"</td>"+',
'      "<td style=\\"color:var(--bl)\\">"+(d.cfUl<0?"--":d.cfUl.toFixed(2))+"</td>"+',
'      "<td>"+(d.cfPing<0?"--":Math.round(d.cfPing))+"</td>"+',
'      "<td>"+badge+"</td>";',
'    tb.appendChild(tr);',
'  });',
'}',
'',
'function G(id){return document.getElementById(id);}',
'function S(id,h){G(id).innerHTML=h;}',
'function T(id,t){G(id).textContent=t;}',
'function fmt(iso){if(!iso)return "--";var d=new Date(iso);return d.toLocaleDateString("fr-FR",{month:"2-digit",day:"2-digit"})+" "+d.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});}',
'function fmtS(iso){if(!iso)return "";return new Date(iso).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});}',
'function fmtS2(iso){if(!iso)return "--";var d=new Date(iso);return d.toLocaleDateString("fr-FR",{month:"2-digit",day:"2-digit"})+" "+d.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});}',
'function ra(hex,a){',
'  hex=hex.trim();',
'  if(hex.indexOf("rgb")===0){var m=hex.match(/[\\d.]+/g);return m?"rgba("+m[0]+","+m[1]+","+m[2]+","+a+")":"rgba(128,128,128,"+a+")";}',
'  var rv=parseInt(hex.slice(1,3),16),gv=parseInt(hex.slice(3,5),16),bv=parseInt(hex.slice(5,7),16);',
'  return "rgba("+rv+","+gv+","+bv+","+a+")";',
'}',
'',
'(function(){',
'  var el=G("recScroll");',
'  el.addEventListener("wheel",function(e){if(e.deltaY!==0){e.preventDefault();el.scrollLeft+=e.deltaY;}},{passive:false});',
'  var down=false,startX=0,scrollL=0;',
'  el.addEventListener("mousedown",function(e){down=true;startX=e.pageX-el.offsetLeft;scrollL=el.scrollLeft;el.style.cursor="grabbing";});',
'  el.addEventListener("mouseleave",function(){down=false;el.style.cursor="grab";});',
'  el.addEventListener("mouseup",function(){down=false;el.style.cursor="grab";});',
'  el.addEventListener("mousemove",function(e){if(!down)return;e.preventDefault();el.scrollLeft=scrollL-(e.pageX-el.offsetLeft-startX);});',
'})();',
'',
'document.getElementById("btnSync").addEventListener("click",fetchData);',
'document.getElementById("bTest").addEventListener("click",triggerTest);',
'document.getElementById("bAuto").addEventListener("click",toggleAuto);',
'document.getElementById("b24").addEventListener("click",function(){setW(24);});',
'document.getElementById("b7").addEventListener("click",function(){setW(168);});',
'document.getElementById("b30").addEventListener("click",function(){setW(720);});',
'document.getElementById("vBoth").addEventListener("click",function(){setDataView("both");});',
'document.getElementById("vOokla").addEventListener("click",function(){setDataView("ookla");});',
'document.getElementById("vCF").addEventListener("click",function(){setDataView("cf");});',
'document.getElementById("btnApply").addEventListener("click",applyThr);',
'document.getElementById("int5").addEventListener("click",function(){setInterval_(5);});',
'document.getElementById("int30").addEventListener("click",function(){setInterval_(30);});',
'document.getElementById("int60").addEventListener("click",function(){setInterval_(60);});',
'document.getElementById("int180").addEventListener("click",function(){setInterval_(180);});',
'document.getElementById("int360").addEventListener("click",function(){setInterval_(360);});',
'document.getElementById("btnPause").addEventListener("click",togglePause);',
'document.getElementById("btnTailOnly").addEventListener("click",toggleTailOnly);',
'document.getElementById("btnSaveTailIp").addEventListener("click",saveTailIp);',
'document.getElementById("fAll").addEventListener("click",function(){setFilter("all");});',
'document.getElementById("fDrop").addEventListener("click",function(){setFilter("drop");});',
'document.getElementById("fHiPing").addEventListener("click",function(){setFilter("hiping");});',
'document.getElementById("fOk").addEventListener("click",function(){setFilter("ok");});',
'document.getElementById("fPartial").addEventListener("click",function(){setFilter("partial");});',
'document.getElementById("btnCheck").addEventListener("click",checkUpdate);',
'document.getElementById("btnInstall").addEventListener("click",doInstall);',
'',
'fetchData();',
'</script>',
'</body>',
'</html>',
].join('\n');



// -- HTTP server
const server = http.createServer(function(req, res) {
  const method = req.method;
  const url    = req.url.split('?')[0];

  if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (url === '/' || url === '/index.html') {
    const cookies = parseCookies(req);
    const skin    = Math.min(parseInt(cookies['nw-skin'] || String(cfg.skin || 0), 10), 2);
    const html    = buildHTML(skin);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie':   'nw-skin=' + skin + '; Path=/; Max-Age=31536000',
    });
    res.end(html);
    return;
  }

  if (url.startsWith('/api/')) { handleAPI(req, res); return; }
  if (url === '/health') { jsonResp(res, 200, { ok:true, records:db.length, version:VERSION }); return; }
  jsonResp(res, 404, { message:'Not found' });
});

server.on('error', function(e) { console.error('[server]', e.message); process.exit(1); });

loadConfig();
loadData();
startScheduler();

server.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('  NetWatch v' + VERSION);
  console.log('  http://0.0.0.0:' + PORT);
  console.log('  data  : ' + DATA_FILE + ' (' + db.length + ' records)');
  console.log('  ookla : ' + (fs.existsSync(SPEEDTEST) ? 'OK' : 'MISSING'));
  console.log('  next  : ' + (nextRun ? nextRun.toISOString() : 'paused'));
  console.log('');
});

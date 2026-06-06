<?php
// Rclone Backup — cedwatch
// Single-file PHP app: config + status + log

define('CONFIG_DIR', '/data/config');
define('SETTINGS',   CONFIG_DIR . '/settings.json');
define('RCLONE_CONF',CONFIG_DIR . '/rclone.conf');
define('KEY_FILE',   CONFIG_DIR . '/id_rsa');
define('LOG_FILE',   CONFIG_DIR . '/backup.log');
define('BACKUPS_DIR','/data/backups');

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadSettings(): array {
    if (!file_exists(SETTINGS)) return [
        'host' => '', 'port' => '21098', 'user' => '',
        'remote' => 'Spaceship', 'source' => 'public_html',
        'folders' => ['blockboard.live', 'ced.watch', 'kartu.page'],
        'excludes' => ['*.mp4', '*.mp3'],
        'hour' => '0', 'minute' => '10',
    ];
    return json_decode(file_get_contents(SETTINGS), true);
}

function saveSettings(array $s): void {
    file_put_contents(SETTINGS, json_encode($s, JSON_PRETTY_PRINT));
}

function writeRcloneConf(array $s): void {
    $conf = "[{$s['remote']}]\n"
          . "type = sftp\n"
          . "host = {$s['host']}\n"
          . "user = {$s['user']}\n"
          . "port = {$s['port']}\n"
          . "key_file = " . KEY_FILE . "\n"
          . "shell_type = unix\n"
          . "md5sum_command = md5sum\n"
          . "sha1sum_command = sha1sum\n";
    file_put_contents(RCLONE_CONF, $conf);
}

function updateCron(array $s): void {
    $min  = intval($s['minute'] ?? 10);
    $hour = intval($s['hour']   ?? 0);
    $line = "$min $hour * * * /usr/local/bin/rclone-backup.sh >> " . LOG_FILE . " 2>&1";
    file_put_contents('/tmp/crontab.tmp', $line . "\n");
    exec('crontab /tmp/crontab.tmp');
}

function logTail(int $lines = 50): string {
    if (!file_exists(LOG_FILE)) return 'No backup run yet.';
    $all = file(LOG_FILE);
    return implode('', array_slice($all, -$lines));
}

function backupStatus(): array {
    $dirs = glob(BACKUPS_DIR . '/daily_*', GLOB_ONLYDIR) ?: [];
    $status = [];
    foreach ($dirs as $d) {
        $day  = basename($d);
        $size = exec("du -sh " . escapeshellarg($d) . " 2>/dev/null | cut -f1");
        $mtime = filemtime($d);
        $status[] = ['day' => $day, 'size' => $size ?: '?', 'mtime' => date('Y-m-d H:i', $mtime)];
    }
    return $status;
}

// ── Actions ───────────────────────────────────────────────────────────────────

$msg = '';
$msgType = '';

// Save config
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action'])) {

    if ($_POST['action'] === 'save') {
        $s = loadSettings();
        $s['host']    = trim($_POST['host']    ?? '');
        $s['port']    = trim($_POST['port']    ?? '21098');
        $s['user']    = trim($_POST['user']    ?? '');
        $s['remote']  = trim($_POST['remote']  ?? 'Spaceship');
        $s['source']  = trim($_POST['source']  ?? 'public_html');
        $s['hour']    = trim($_POST['hour']    ?? '0');
        $s['minute']  = trim($_POST['minute']  ?? '10');

        // Folders & excludes — one per line
        $s['folders'] = array_filter(array_map('trim', explode("\n", $_POST['folders'] ?? '')));
        $s['excludes']= array_filter(array_map('trim', explode("\n", $_POST['excludes'] ?? '')));

        // SSH key upload
        if (!empty($_FILES['keyfile']['tmp_name'])) {
            move_uploaded_file($_FILES['keyfile']['tmp_name'], KEY_FILE);
            chmod(KEY_FILE, 0600);
        }

        saveSettings($s);
        writeRcloneConf($s);
        updateCron($s);
        $msg = '✓ Settings saved. Cron updated.';
        $msgType = 'ok';
    }

    // Test connection
    if ($_POST['action'] === 'test') {
        $s = loadSettings();
        if (!file_exists(RCLONE_CONF) || !file_exists(KEY_FILE)) {
            $msg = '✗ Missing rclone.conf or SSH key. Save settings first.';
            $msgType = 'err';
        } else {
            $out = [];
            exec(
                '/usr/local/bin/rclone lsd --config ' . escapeshellarg(RCLONE_CONF)
                . ' ' . escapeshellarg($s['remote'] . ':' . $s['source'])
                . ' --sftp-key-file ' . escapeshellarg(KEY_FILE)
                . ' 2>&1',
                $out, $code
            );
            if ($code === 0) {
                $msg = '✓ Connection OK. Folders found: ' . implode(', ', array_map('trim', $out));
                $msgType = 'ok';
            } else {
                $msg = '✗ Connection failed: ' . htmlspecialchars(implode(' ', $out));
                $msgType = 'err';
            }
        }
    }

    // Run now
    if ($_POST['action'] === 'runnow') {
        exec('nohup /usr/local/bin/rclone-backup.sh >> /data/config/backup.log 2>&1 &');
        $msg = '✓ Backup started in background. Check log below.';
        $msgType = 'ok';
    }
}

$s = loadSettings();
$log = logTail();
$bkp = backupStatus();
$keyExists = file_exists(KEY_FILE);
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rclone Backup</title>
<style>
:root{--bg:#0d1a14;--panel:#152019;--green:#2d6a4f;--gold:#d4a843;--cream:#f5f0e8;--dim:#8a9e93;--ok:#52b788;--err:#e76f51;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--cream);font-family:system-ui,sans-serif;font-size:15px;padding:20px;max-width:720px;margin:0 auto;}
h1{color:var(--gold);font-size:1.4rem;margin-bottom:2px;}
.sub{color:var(--dim);font-size:.82rem;margin-bottom:20px;}
h2{color:var(--gold);font-size:1rem;margin-bottom:10px;}
.card{background:var(--panel);border:1px solid var(--green);border-radius:8px;padding:16px;margin-bottom:16px;}
label{display:block;color:var(--dim);font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;margin-top:10px;}
label:first-child{margin-top:0;}
input[type=text],input[type=number],textarea{width:100%;background:#0a1209;border:1px solid var(--green);border-radius:5px;color:var(--cream);padding:7px 10px;font-size:.9rem;font-family:monospace;}
textarea{resize:vertical;min-height:72px;}
.row{display:flex;gap:10px;}
.row>*{flex:1;}
input[type=file]{color:var(--dim);font-size:.82rem;margin-top:4px;}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;}
button{padding:8px 16px;border:none;border-radius:5px;cursor:pointer;font-size:.88rem;font-weight:600;}
.btn-save{background:var(--green);color:var(--cream);}
.btn-test{background:#1e3a2f;color:var(--ok);border:1px solid var(--ok);}
.btn-run{background:#2a1a0a;color:var(--gold);border:1px solid var(--gold);}
.msg{padding:10px 14px;border-radius:6px;font-size:.88rem;margin-bottom:14px;}
.msg.ok{background:#0d2b1a;color:var(--ok);border:1px solid var(--ok);}
.msg.err{background:#2b0d0d;color:var(--err);border:1px solid var(--err);}
.key-ok{color:var(--ok);font-size:.82rem;margin-top:4px;}
.key-missing{color:var(--err);font-size:.82rem;margin-top:4px;}
.bkp-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}
.bkp-item{background:#0a1209;border:1px solid var(--green);border-radius:5px;padding:6px 10px;font-size:.8rem;}
.bkp-day{color:var(--gold);font-weight:600;}
.bkp-meta{color:var(--dim);}
.log{background:#070f09;border-radius:6px;padding:12px;font-size:.75rem;color:var(--dim);white-space:pre-wrap;max-height:280px;overflow-y:auto;font-family:monospace;margin-top:8px;}
.footer{color:var(--dim);font-size:.75rem;margin-top:20px;}
a{color:var(--gold);}
</style>
</head>
<body>

<h1>📦 Rclone Backup</h1>
<p class="sub">Automated SFTP backup for your web hosting — by <a href="https://ced.watch" target="_blank">ced.watch</a></p>

<?php if ($msg): ?>
<div class="msg <?= $msgType ?>"><?= $msg ?></div>
<?php endif; ?>

<!-- CONFIG -->
<div class="card">
<h2>🔧 Configuration</h2>
<form method="POST" enctype="multipart/form-data">
<input type="hidden" name="action" value="save">

<div class="row">
  <div>
    <label>SFTP Host</label>
    <input type="text" name="host" value="<?= htmlspecialchars($s['host']) ?>" placeholder="209.74.68.24">
  </div>
  <div>
    <label>Port</label>
    <input type="text" name="port" value="<?= htmlspecialchars($s['port']) ?>" placeholder="21098">
  </div>
</div>

<div class="row">
  <div>
    <label>Username (cPanel)</label>
    <input type="text" name="user" value="<?= htmlspecialchars($s['user']) ?>" placeholder="cpanel_user">
  </div>
  <div>
    <label>Remote name</label>
    <input type="text" name="remote" value="<?= htmlspecialchars($s['remote']) ?>" placeholder="Spaceship">
  </div>
</div>

<label>Source folder on server</label>
<input type="text" name="source" value="<?= htmlspecialchars($s['source']) ?>" placeholder="public_html">

<label>SSH Private Key (id_rsa)</label>
<input type="file" name="keyfile" accept="*">
<?php if ($keyExists): ?>
  <div class="key-ok">✓ Key on file — upload new to replace</div>
<?php else: ?>
  <div class="key-missing">✗ No key uploaded yet</div>
<?php endif; ?>

<label>Folders to backup (one per line)</label>
<textarea name="folders"><?= htmlspecialchars(implode("\n", $s['folders'])) ?></textarea>

<label>Exclude patterns (one per line)</label>
<textarea name="excludes" style="min-height:50px"><?= htmlspecialchars(implode("\n", $s['excludes'])) ?></textarea>

<div class="row" style="margin-top:10px;">
  <div>
    <label>Backup hour (UTC 0–23)</label>
    <input type="number" name="hour" value="<?= intval($s['hour']) ?>" min="0" max="23">
  </div>
  <div>
    <label>Minute (0–59)</label>
    <input type="number" name="minute" value="<?= intval($s['minute']) ?>" min="0" max="59">
  </div>
</div>

<div class="btns">
  <button type="submit" class="btn-save">💾 Save Settings</button>
</div>
</form>

<form method="POST" style="display:inline">
<input type="hidden" name="action" value="test">
<div class="btns" style="margin-top:8px;">
  <button type="submit" class="btn-test">🔌 Test Connection</button>
  <button type="submit" form="runnow" class="btn-run">▶ Run Backup Now</button>
</div>
</form>
<form method="POST" id="runnow">
<input type="hidden" name="action" value="runnow">
</form>
</div>

<!-- BACKUP STATUS -->
<div class="card">
<h2>📁 Backup Status — Rolling 7 days</h2>
<?php if ($bkp): ?>
<div class="bkp-list">
<?php foreach ($bkp as $b): ?>
  <div class="bkp-item">
    <div class="bkp-day"><?= htmlspecialchars($b['day']) ?></div>
    <div class="bkp-meta"><?= htmlspecialchars($b['size']) ?> — <?= htmlspecialchars($b['mtime']) ?></div>
  </div>
<?php endforeach; ?>
</div>
<?php else: ?>
<div style="color:var(--dim);font-size:.85rem;">No backups yet. Run your first backup above.</div>
<?php endif; ?>
</div>

<!-- LOG -->
<div class="card">
<h2>📋 Last 50 log lines <span style="color:var(--dim);font-size:.8rem;font-weight:400">(auto-refresh 60s)</span></h2>
<div class="log" id="log"><?= htmlspecialchars($log) ?></div>
</div>

<p class="footer">Rclone Backup v1.0.0 — Built in Kampot, Cambodia — <a href="https://ced.watch" target="_blank">ced.watch</a></p>

<script>
// Auto-scroll log to bottom
var l = document.getElementById('log');
l.scrollTop = l.scrollHeight;
// Auto-refresh page every 60s
setTimeout(function(){ location.reload(); }, 60000);
</script>
</body>
</html>

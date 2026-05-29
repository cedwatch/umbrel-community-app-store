<?php
/* BLOCKBOARD api.php — blockboard.live — PHP 8.1 */
error_reporting(0);          /* no warnings to stdout */
@ini_set('display_errors','0');
ob_start();                  /* trap any accidental output before JSON */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-store, no-cache, must-revalidate');
ob_clean();                  /* discard anything output before headers */

/* ── HELPERS ──────────────────────────────────────────────── */
function fget(string $url, int $timeout = 10): ?string {
    $ctx = stream_context_create(['http' => [
        'timeout'        => $timeout,
        'ignore_errors'  => true,
        'follow_location'=> 1,
        'header'         => implode("\r\n", [
            'User-Agent: Mozilla/5.0 (compatible; BlockBoard/7.0; +https://blockboard.live)',
            'Accept: application/json, text/plain, */*',
            'Accept-Encoding: identity',
        ]),
    ]]);
    $raw = @file_get_contents($url, false, $ctx);
    return ($raw !== false && $raw !== '') ? $raw : null;
}

function jget(string $url, int $timeout = 10): ?array {
    $r = fget($url, $timeout);
    if (!$r) return null;
    $d = json_decode($r, true);
    return is_array($d) ? $d : null;
}

function grabText(string $url, int $timeout = 8): ?string {
    $r = fget($url, $timeout);
    return $r ? trim($r) : null;
}

/* cached jget — serves stale on failure */
function jcache(string $url, string $key, int $ttl = 600, int $timeout = 12): ?array {
    $f = sys_get_temp_dir().'/bb_'.preg_replace('/\W/','_',$key).'.json';
    if (file_exists($f) && (time()-filemtime($f)) < $ttl) {
        $d = json_decode(file_get_contents($f), true);
        if (is_array($d)) return $d;
    }
    $r = fget($url, $timeout);
    if ($r) { $d = json_decode($r, true); if (is_array($d)) { file_put_contents($f, $r); return $d; } }
    /* stale fallback */
    if (file_exists($f)) { $d = json_decode(file_get_contents($f), true); if (is_array($d)) return $d; }
    return null;
}

/* ══ RAW ERROR PROBE  ?probe=1  ══════════════════════════════
   Shows raw PHP output with errors enabled — use ONCE to diagnose
   then remove from URL. Safe: only outputs text, no sensitive data.
   ══════════════════════════════════════════════════════════════ */
if (isset($_GET['probe'])) {
    ob_end_clean();
    error_reporting(E_ALL);
    ini_set('display_errors', '1');
    header('Content-Type: text/plain; charset=utf-8');
    echo "PHP " . PHP_VERSION . "
";
    echo "Server: " . ($_SERVER['SERVER_SOFTWARE']??'?') . "
";
    echo "Temp dir: " . sys_get_temp_dir() . "
";
    echo "allow_url_fopen: " . (ini_get('allow_url_fopen')?'ON':'OFF') . "
";
    /* test a simple fetch */
    $t = @file_get_contents('https://mempool.space/api/blocks/tip/height');
    echo "mempool test: " . ($t ? "OK len=".strlen($t) : "FAIL") . "
";
    $k = @file_get_contents('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
    echo "kraken test: " . ($k ? "OK len=".strlen($k) : "FAIL") . "\n";
    $fg = @file_get_contents('https://api.alternative.me/fng/?limit=1');
    echo "alt.me (legacy, unused): " . ($fg ? "reachable" : "FAIL") . "\n";
    /* BlockBoard Pulse is now calculated server-side — no external F&G needed */
    $ln = @file_get_contents('https://1ml.com/statistics?json=true');
    echo "1ml test: " . ($ln ? "OK len=".strlen($ln)." full=".$ln : "FAIL") . "\n";
    exit;
}

/* ══ CLEAR CACHE ROUTE  ?clearcache=1 ════════════════════════
   Wipes all chart cache files from /tmp — run once after update */
if (isset($_GET['clearcache'])) {
    $tmp = sys_get_temp_dir();
    $deleted = [];
    foreach (glob($tmp.'/bb_chart_*.json') as $f) { unlink($f); $deleted[] = basename($f); }
    foreach (glob($tmp.'/bb_cg_*.json')    as $f) { unlink($f); $deleted[] = basename($f); }
    foreach (glob($tmp.'/bb_*.json')       as $f) { unlink($f); $deleted[] = basename($f); }
    ob_end_clean();
    echo json_encode(['cleared' => $deleted, 'count' => count($deleted)]);
    exit;
}

/* ══ PAIR ROUTE  ?pair=XBTEUR|XBTGBP|... ════════════════════
   Returns live Kraken ticker for any BTC pair.
   Used by the front-end pair selector for non-USD pairs.    */
if (isset($_GET['pair']) && !isset($_GET['chart'])) {
    $pair = strtoupper(preg_replace('/[^A-Z0-9]/', '', $_GET['pair']));
    $allowed = ['XBTUSD','XBTEUR','XBTGBP','XBTJPY','XBTCHF','XBTCAD','XBTAUD','XBTUSDT','PAXGXBT'];
    if (!in_array($pair, $allowed, true)) { echo '{"error":"bad pair"}'; exit; }
    $d = jget("https://api.kraken.com/0/public/Ticker?pair={$pair}", 8);
    if ($d && empty($d['error']) && isset($d['result'])) {
        $keys = array_diff(array_keys($d['result']), ['last']);
        $key  = reset($keys);
        $t    = $d['result'][$key] ?? null;
        if ($t && isset($t['c'][0])) {
            $price = (float)$t['c'][0];
            $open  = (float)($t['o'] ?? $price);
            ob_end_clean();
        echo json_encode([
                'pair'  => $pair,
                'price' => [
                    'price'   => $price,
                    'chg24h'  => $open > 0 ? round(($price-$open)/$open*100, 2) : 0,
                    'high24h' => (float)($t['h'][1] ?? 0),
                    'low24h'  => (float)($t['l'][1] ?? 0),
                    'vol24h'  => (float)($t['v'][1] ?? 0) * $price,
                ],
                'ok' => true,
            ], JSON_UNESCAPED_SLASHES);
            exit;
        }
    }
    ob_end_clean();
    echo '{"error":"fetch_failed","ok":false}';
    exit;
}

/* ══ DEBUG ROUTE  ?debug=1 ═══════════════════════════════════ */
if (isset($_GET['debug'])) {
    $tests = [
        'mempool_fees'    => 'https://mempool.space/api/v1/fees/recommended',
        'mempool_height'  => 'https://mempool.space/api/blocks/tip/height',
        'kraken_ticker'   => 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
        'kraken_ohlc_1d'  => 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440&since='.( time()-35*86400 ),
        'bitstamp_ticker' => 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
        'coingecko_price' => 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
        'wttr_test'       => 'https://wttr.in/Phnom+Penh?format=j1&lang=en',
        'wttr_kampot'     => 'https://wttr.in/Kampot?format=j1',
        'block_hash'      => 'https://mempool.space/api/blocks/tip/hash',
        'block_v1_tip'    => 'https://mempool.space/api/v1/blocks/tip',
    ];
    $res = [];
    foreach ($tests as $name => $url) {
        $raw = fget($url, 8);
        $code = 0;
        /* try to detect HTTP response code from $http_response_header */
        if (isset($http_response_header)) {
            foreach ($http_response_header as $h) {
                if (preg_match('/HTTP\/[\d.]+ (\d+)/', $h, $m)) { $code = (int)$m[1]; break; }
            }
        }
        $res[$name] = [
            'ok'      => ($raw !== null && $code >= 200 && $code < 400),
            'http'    => $code,
            'bytes'   => $raw ? strlen($raw) : 0,
            'preview' => $raw ? substr($raw, 0, 80) : null,
        ];
    }
    ob_end_clean();
    echo json_encode(['debug'=>true,'ts'=>time(),'php'=>PHP_VERSION,'results'=>$res], JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES);
    exit;
}

/* ══ CHART ROUTE  ?chart=1h|4h|1d|1w|1m|3m|1y|5y|max[&pair=XBTEUR] ═
   Returns OHLC candles: {ohlc:[[ts_ms,o,h,l,c],...], prices:[[ts,c],...]}
   Kraken intervals (min): 1, 60, 240, 1440, 10080
   1m default = 30 daily candles. 5y/max = weekly (10080) candles.
   pair param: XBTUSD (default), XBTEUR, XBTGBP, XBTJPY, XBTCHF, XBTCAD, XBTAUD, XBTUSDT
   PAXGXBT has short history — 5y/max auto-fallback to XBTUSD.
   ════════════════════════════════════════════════════════════ */
if (isset($_GET['chart'])) {
    $range = $_GET['chart'];

    /* ── Pair param ──────────────────────────────────────────── */
    $ALLOWED_CHART_PAIRS = ['XBTUSD','XBTEUR','XBTGBP','XBTJPY','XBTCHF','XBTCAD','XBTAUD','XBTUSDT','PAXGXBT'];
    $chartPair = strtoupper(preg_replace('/[^A-Z0-9]/', '', $_GET['pair'] ?? 'XBTUSD'));
    if (!in_array($chartPair, $ALLOWED_CHART_PAIRS, true)) $chartPair = 'XBTUSD';

    /* [interval_min, candles, cache_ttl_sec] */
    $cfg = [
        '1h'  => [    1,  60,   120],
        '4h'  => [    5,  48,   300],
        '1d'  => [   30,  48,   300],
        '1w'  => [  240,  42,   600],
        '1m'  => [ 1440,  35,  1800],
        '3m'  => [ 1440,  90,  3600],
        '1y'  => [ 1440, 365,  7200],
        '5y'  => [10080, 260,  7200],
        'max' => [10080, 720, 14400],
    ];
    /* Pairs with limited history — cap at 1y, fallback to XBTUSD for long ranges */
    $SHORT_HISTORY = ['XBTJPY','XBTCAD','XBTAUD','XBTUSDT','PAXGXBT'];
    $LONG_RANGES   = ['5y','max'];
    if (in_array($chartPair, $SHORT_HISTORY, true) && in_array($range, $LONG_RANGES, true)) {
        $chartPair = 'XBTUSD'; /* silent fallback */
    }

    if (!isset($cfg[$range])) { ob_end_clean(); echo '{"error":"bad range"}'; exit; }

    list($iv, $lim, $ttl) = $cfg[$range];
    /* cache key includes pair so XBTEUR 1d ≠ XBTUSD 1d */
    $pairSuffix = ($chartPair === 'XBTUSD') ? '' : '_'.strtolower($chartPair);
    $cf = sys_get_temp_dir().'/bb_ohlc_'.$range.$pairSuffix.'.json';

    /* serve valid cache */
    if (file_exists($cf) && (time()-filemtime($cf)) < $ttl) {
        $cached = file_get_contents($cf);
        $check  = json_decode($cached, true);
        if (!empty($check['ohlc']) && ($check['source']??'') === 'kraken') {
            ob_end_clean(); echo $cached; exit;
        }
        @unlink($cf);
    }

    $since = time() - ($iv * 60 * ($lim + 8));
    $url   = "https://api.kraken.com/0/public/OHLC?pair={$chartPair}&interval={$iv}&since={$since}";
    $d     = jget($url, 15);

    $ohlc = [];
    if ($d && empty($d['error']) && isset($d['result'])) {
        $keys = array_diff(array_keys($d['result']), ['last']);
        $key  = reset($keys);
        if ($key && is_array($d['result'][$key])) {
            $rows = array_slice($d['result'][$key], -$lim);
            foreach ($rows as $row) {
                /* [ts_ms, open, high, low, close] */
                $ohlc[] = [(int)$row[0]*1000,(float)$row[1],(float)$row[2],(float)$row[3],(float)$row[4]];
            }
        }
    }

    if (count($ohlc) > 1) {
        $out = json_encode([
            'ohlc'   => $ohlc,
            'prices' => array_map(function($r){return [$r[0],$r[4]];}, $ohlc),
            'source' => 'kraken',
            'pair'   => $chartPair,
            'range'  => $range,
            'pts'    => count($ohlc),
            'iv'     => $iv,
        ]);
        file_put_contents($cf, $out);
        ob_end_clean(); echo $out;
    } elseif (file_exists($cf)) {
        ob_end_clean(); echo file_get_contents($cf);
    } else {
        ob_end_clean(); echo json_encode(['error'=>'fetch_failed','range'=>$range]);
    }
    exit;
}

/* ══ MAIN BUNDLE ══════════════════════════════════════════════ */
$out    = ['ok' => false, 'ts' => time()];
$errors = [];

/* ── TIMEZONE LOOKUP ─────────────────────────────────────────
   PHP-side city→tz + country→tz resolution.
   Uses wttr's canonical resolved city name (much cleaner than
   user input). Falls back to single-tz country table.
   ────────────────────────────────────────────────────────── */
function resolveTimezone(string $city, string $region, string $country): string {
    /* Normalize: lowercase, trim */
    $c  = strtolower(trim($city));
    $r  = strtolower(trim($region));
    $co = strtolower(trim($country));

    /* ── City map (canonical wttr-resolved names) ────────── */
    $CITY = [
        /* Cambodia */
        'phnom penh'=>'Asia/Bangkok','kampot'=>'Asia/Bangkok','siem reap'=>'Asia/Bangkok',
        'battambang'=>'Asia/Bangkok','sihanoukville'=>'Asia/Bangkok','kampong cham'=>'Asia/Bangkok',
        'krong preah sihanouk'=>'Asia/Bangkok','kandal'=>'Asia/Bangkok',
        'phumi khnach run'=>'Asia/Bangkok','prey veng'=>'Asia/Bangkok',
        /* SE Asia */
        'bangkok'=>'Asia/Bangkok','chiang mai'=>'Asia/Bangkok','phuket'=>'Asia/Bangkok',
        'pattaya'=>'Asia/Bangkok','chiang rai'=>'Asia/Bangkok','hat yai'=>'Asia/Bangkok',
        'vientiane'=>'Asia/Vientiane','luang prabang'=>'Asia/Vientiane',
        'ho chi minh city'=>'Asia/Ho_Chi_Minh','saigon'=>'Asia/Ho_Chi_Minh',
        'hanoi'=>'Asia/Bangkok','da nang'=>'Asia/Ho_Chi_Minh','hue'=>'Asia/Ho_Chi_Minh',
        'yangon'=>'Asia/Rangoon','naypyidaw'=>'Asia/Rangoon','mandalay'=>'Asia/Rangoon',
        'jakarta'=>'Asia/Jakarta','surabaya'=>'Asia/Jakarta','bandung'=>'Asia/Jakarta',
        'bali'=>'Asia/Makassar','denpasar'=>'Asia/Makassar','lombok'=>'Asia/Makassar',
        'kuala lumpur'=>'Asia/Kuala_Lumpur','george town'=>'Asia/Kuala_Lumpur',
        'johor bahru'=>'Asia/Kuala_Lumpur','kota kinabalu'=>'Asia/Kuala_Lumpur',
        'singapore'=>'Asia/Singapore',
        'manila'=>'Asia/Manila','quezon city'=>'Asia/Manila','cebu city'=>'Asia/Manila',
        'davao city'=>'Asia/Manila','tagbilaran'=>'Asia/Manila',
        'bohol'=>'Asia/Manila','palawan'=>'Asia/Manila',
        /* East Asia */
        'hong kong'=>'Asia/Hong_Kong',
        'beijing'=>'Asia/Shanghai','shanghai'=>'Asia/Shanghai','shenzhen'=>'Asia/Shanghai',
        'guangzhou'=>'Asia/Shanghai','chengdu'=>'Asia/Shanghai','wuhan'=>'Asia/Shanghai',
        'tianjin'=>'Asia/Shanghai','nanjing'=>'Asia/Shanghai','xi an'=>'Asia/Shanghai',
        'taipei'=>'Asia/Taipei','kaohsiung'=>'Asia/Taipei',
        'seoul'=>'Asia/Seoul','busan'=>'Asia/Seoul','incheon'=>'Asia/Seoul',
        'tokyo'=>'Asia/Tokyo','osaka'=>'Asia/Tokyo','kyoto'=>'Asia/Tokyo',
        'hiroshima'=>'Asia/Tokyo','sapporo'=>'Asia/Tokyo','fukuoka'=>'Asia/Tokyo',
        'nagoya'=>'Asia/Tokyo','yokohama'=>'Asia/Tokyo',
        /* South Asia */
        'mumbai'=>'Asia/Kolkata','delhi'=>'Asia/Kolkata','new delhi'=>'Asia/Kolkata',
        'bangalore'=>'Asia/Kolkata','kolkata'=>'Asia/Kolkata','chennai'=>'Asia/Kolkata',
        'hyderabad'=>'Asia/Kolkata','pune'=>'Asia/Kolkata','ahmedabad'=>'Asia/Kolkata',
        'jaipur'=>'Asia/Kolkata','lucknow'=>'Asia/Kolkata','surat'=>'Asia/Kolkata',
        'islamabad'=>'Asia/Karachi','karachi'=>'Asia/Karachi','lahore'=>'Asia/Karachi',
        'faisalabad'=>'Asia/Karachi','peshawar'=>'Asia/Karachi',
        'dhaka'=>'Asia/Dhaka','chittagong'=>'Asia/Dhaka',
        'colombo'=>'Asia/Colombo','kathmandu'=>'Asia/Kathmandu',
        'kabul'=>'Asia/Kabul','male'=>'Indian/Maldives','thimphu'=>'Asia/Thimphu',
        /* Middle East */
        'dubai'=>'Asia/Dubai','abu dhabi'=>'Asia/Dubai','sharjah'=>'Asia/Dubai',
        'riyadh'=>'Asia/Riyadh','jeddah'=>'Asia/Riyadh','mecca'=>'Asia/Riyadh',
        'doha'=>'Asia/Qatar','manama'=>'Asia/Bahrain','muscat'=>'Asia/Muscat',
        'kuwait city'=>'Asia/Kuwait','amman'=>'Asia/Amman','beirut'=>'Asia/Beirut',
        'damascus'=>'Asia/Damascus','baghdad'=>'Asia/Baghdad',
        'tehran'=>'Asia/Tehran','isfahan'=>'Asia/Tehran','mashhad'=>'Asia/Tehran',
        'tel aviv'=>'Asia/Jerusalem','jerusalem'=>'Asia/Jerusalem','haifa'=>'Asia/Jerusalem',
        'ankara'=>'Europe/Istanbul','istanbul'=>'Europe/Istanbul','izmir'=>'Europe/Istanbul',
        /* Central Asia */
        'tashkent'=>'Asia/Tashkent','samarkand'=>'Asia/Tashkent',
        'almaty'=>'Asia/Almaty','nur-sultan'=>'Asia/Almaty','astana'=>'Asia/Almaty',
        'bishkek'=>'Asia/Bishkek','dushanbe'=>'Asia/Dushanbe','ashgabat'=>'Asia/Ashgabat',
        'baku'=>'Asia/Baku','yerevan'=>'Asia/Yerevan','tbilisi'=>'Asia/Tbilisi',
        /* Russia */
        'moscow'=>'Europe/Moscow','saint petersburg'=>'Europe/Moscow',
        'novosibirsk'=>'Asia/Novosibirsk','yekaterinburg'=>'Asia/Yekaterinburg',
        'vladivostok'=>'Asia/Vladivostok','irkutsk'=>'Asia/Irkutsk',
        'omsk'=>'Asia/Omsk','krasnoyarsk'=>'Asia/Krasnoyarsk',
        /* Europe — West */
        'paris'=>'Europe/Paris','lyon'=>'Europe/Paris','marseille'=>'Europe/Paris',
        'nice'=>'Europe/Paris','cannes'=>'Europe/Paris','bordeaux'=>'Europe/Paris',
        'toulouse'=>'Europe/Paris','nantes'=>'Europe/Paris','strasbourg'=>'Europe/Paris',
        'lille'=>'Europe/Paris','rennes'=>'Europe/Paris','montpellier'=>'Europe/Paris',
        'la rochelle'=>'Europe/Paris','grenoble'=>'Europe/Paris','dijon'=>'Europe/Paris',
        'reims'=>'Europe/Paris','saint-etienne'=>'Europe/Paris','tours'=>'Europe/Paris',
        'perpignan'=>'Europe/Paris','angers'=>'Europe/Paris','brest'=>'Europe/Paris',
        'london'=>'Europe/London','manchester'=>'Europe/London','birmingham'=>'Europe/London',
        'liverpool'=>'Europe/London','leeds'=>'Europe/London','edinburgh'=>'Europe/London',
        'glasgow'=>'Europe/London','cardiff'=>'Europe/London','bristol'=>'Europe/London',
        'berlin'=>'Europe/Berlin','munich'=>'Europe/Berlin','hamburg'=>'Europe/Berlin',
        'cologne'=>'Europe/Berlin','frankfurt'=>'Europe/Berlin','stuttgart'=>'Europe/Berlin',
        'dusseldorf'=>'Europe/Berlin','dortmund'=>'Europe/Berlin','leipzig'=>'Europe/Berlin',
        'zurich'=>'Europe/Zurich','geneva'=>'Europe/Zurich','bern'=>'Europe/Zurich',
        'basel'=>'Europe/Zurich','lausanne'=>'Europe/Zurich','la neuveville'=>'Europe/Zurich',
        'neuchatel'=>'Europe/Zurich','lugano'=>'Europe/Zurich','winterthur'=>'Europe/Zurich',
        'amsterdam'=>'Europe/Amsterdam','rotterdam'=>'Europe/Amsterdam','the hague'=>'Europe/Amsterdam',
        'brussels'=>'Europe/Brussels','antwerp'=>'Europe/Brussels','ghent'=>'Europe/Brussels',
        'luxembourg city'=>'Europe/Luxembourg',
        'madrid'=>'Europe/Madrid','barcelona'=>'Europe/Madrid','seville'=>'Europe/Madrid',
        'valencia'=>'Europe/Madrid','bilbao'=>'Europe/Madrid','zaragoza'=>'Europe/Madrid',
        'rome'=>'Europe/Rome','milan'=>'Europe/Rome','naples'=>'Europe/Rome',
        'turin'=>'Europe/Rome','palermo'=>'Europe/Rome','florence'=>'Europe/Rome',
        'bologna'=>'Europe/Rome','venice'=>'Europe/Rome','genoa'=>'Europe/Rome',
        'vienna'=>'Europe/Vienna','graz'=>'Europe/Vienna','salzburg'=>'Europe/Vienna',
        'lisbon'=>'Europe/Lisbon','porto'=>'Europe/Lisbon','faro'=>'Europe/Lisbon',
        /* Europe — North */
        'stockholm'=>'Europe/Stockholm','gothenburg'=>'Europe/Stockholm','malmo'=>'Europe/Stockholm',
        'oslo'=>'Europe/Oslo','bergen'=>'Europe/Oslo','trondheim'=>'Europe/Oslo',
        'copenhagen'=>'Europe/Copenhagen','aarhus'=>'Europe/Copenhagen',
        'helsinki'=>'Europe/Helsinki','tampere'=>'Europe/Helsinki','turku'=>'Europe/Helsinki',
        'reykjavik'=>'Atlantic/Reykjavik',
        /* Europe — East */
        'warsaw'=>'Europe/Warsaw','krakow'=>'Europe/Warsaw','lodz'=>'Europe/Warsaw',
        'wroclaw'=>'Europe/Warsaw','poznan'=>'Europe/Warsaw','gdansk'=>'Europe/Warsaw',
        'prague'=>'Europe/Prague','brno'=>'Europe/Prague',
        'budapest'=>'Europe/Budapest','debrecen'=>'Europe/Budapest',
        'bucharest'=>'Europe/Bucharest','cluj-napoca'=>'Europe/Bucharest',
        'sofia'=>'Europe/Sofia','plovdiv'=>'Europe/Sofia',
        'athens'=>'Europe/Athens','thessaloniki'=>'Europe/Athens',
        'belgrade'=>'Europe/Belgrade','novi sad'=>'Europe/Belgrade',
        'zagreb'=>'Europe/Zagreb','split'=>'Europe/Zagreb',
        'ljubljana'=>'Europe/Ljubljana','bratislava'=>'Europe/Bratislava',
        'tallinn'=>'Europe/Tallinn','riga'=>'Europe/Riga','vilnius'=>'Europe/Vilnius',
        'kyiv'=>'Europe/Kiev','kharkiv'=>'Europe/Kiev','odessa'=>'Europe/Kiev',
        'minsk'=>'Europe/Minsk','chisinau'=>'Europe/Chisinau',
        'tirana'=>'Europe/Tirane','sarajevo'=>'Europe/Sarajevo',
        'skopje'=>'Europe/Skopje','podgorica'=>'Europe/Podgorica',
        'nicosia'=>'Asia/Nicosia',
        /* Africa */
        'cairo'=>'Africa/Cairo','alexandria'=>'Africa/Cairo','giza'=>'Africa/Cairo',
        'casablanca'=>'Africa/Casablanca','rabat'=>'Africa/Casablanca','marrakech'=>'Africa/Casablanca',
        'tunis'=>'Africa/Tunis','algiers'=>'Africa/Algiers','tripoli'=>'Africa/Tripoli',
        'lagos'=>'Africa/Lagos','abuja'=>'Africa/Lagos','kano'=>'Africa/Lagos',
        'accra'=>'Africa/Accra','kumasi'=>'Africa/Accra',
        'dakar'=>'Africa/Dakar','abidjan'=>'Africa/Abidjan',
        'bamako'=>'Africa/Bamako','ouagadougou'=>'Africa/Ouagadougou',
        'conakry'=>'Africa/Conakry','freetown'=>'Africa/Freetown',
        'nairobi'=>'Africa/Nairobi','mombasa'=>'Africa/Nairobi',
        'addis ababa'=>'Africa/Addis_Ababa','dar es salaam'=>'Africa/Dar_es_Salaam',
        'kampala'=>'Africa/Kampala','kigali'=>'Africa/Kigali',
        'johannesburg'=>'Africa/Johannesburg','cape town'=>'Africa/Johannesburg',
        'durban'=>'Africa/Johannesburg','pretoria'=>'Africa/Johannesburg',
        'harare'=>'Africa/Harare','lusaka'=>'Africa/Lusaka',
        'khartoum'=>'Africa/Khartoum','kinshasa'=>'Africa/Kinshasa',
        'luanda'=>'Africa/Luanda','maputo'=>'Africa/Maputo',
        /* Americas — North */
        'new york city'=>'America/New_York','new york'=>'America/New_York',
        'manhattan'=>'America/New_York','brooklyn'=>'America/New_York',
        'miami'=>'America/New_York','boston'=>'America/New_York',
        'philadelphia'=>'America/New_York','atlanta'=>'America/New_York',
        'washington'=>'America/New_York','charlotte'=>'America/New_York',
        'toronto'=>'America/Toronto','montreal'=>'America/Toronto','ottawa'=>'America/Toronto',
        'chicago'=>'America/Chicago','houston'=>'America/Chicago',
        'dallas'=>'America/Chicago','san antonio'=>'America/Chicago',
        'minneapolis'=>'America/Chicago','kansas city'=>'America/Chicago',
        'denver'=>'America/Denver','salt lake city'=>'America/Denver',
        'phoenix'=>'America/Phoenix','tucson'=>'America/Phoenix',
        'los angeles'=>'America/Los_Angeles','san francisco'=>'America/Los_Angeles',
        'san diego'=>'America/Los_Angeles','seattle'=>'America/Los_Angeles',
        'portland'=>'America/Los_Angeles','las vegas'=>'America/Los_Angeles',
        'vancouver'=>'America/Vancouver','calgary'=>'America/Edmonton',
        'edmonton'=>'America/Edmonton','winnipeg'=>'America/Winnipeg',
        'mexico city'=>'America/Mexico_City','guadalajara'=>'America/Mexico_City',
        'monterrey'=>'America/Monterrey','tijuana'=>'America/Tijuana',
        'havana'=>'America/Havana','kingston'=>'America/Jamaica',
        'san juan'=>'America/Puerto_Rico','nassau'=>'America/Nassau',
        'port au prince'=>'America/Port-au-Prince',
        'santo domingo'=>'America/Santo_Domingo',
        'san salvador'=>'America/El_Salvador','tegucigalpa'=>'America/Tegucigalpa',
        'managua'=>'America/Managua','san jose'=>'America/Costa_Rica',
        'panama city'=>'America/Panama','guatemala city'=>'America/Guatemala',
        /* Americas — South */
        'bogota'=>'America/Bogota','medellin'=>'America/Bogota','cali'=>'America/Bogota',
        'caracas'=>'America/Caracas','maracaibo'=>'America/Caracas',
        'lima'=>'America/Lima','quito'=>'America/Guayaquil',
        'la paz'=>'America/La_Paz','santa cruz de la sierra'=>'America/La_Paz',
        'asuncion'=>'America/Asuncion','montevideo'=>'America/Montevideo',
        'buenos aires'=>'America/Argentina/Buenos_Aires',
        'santiago'=>'America/Santiago','valparaiso'=>'America/Santiago',
        'sao paulo'=>'America/Sao_Paulo','rio de janeiro'=>'America/Sao_Paulo',
        'brasilia'=>'America/Sao_Paulo','belo horizonte'=>'America/Sao_Paulo',
        'fortaleza'=>'America/Fortaleza','recife'=>'America/Recife',
        'manaus'=>'America/Manaus','belem'=>'America/Belem',
        /* Oceania */
        'sydney'=>'Australia/Sydney','melbourne'=>'Australia/Melbourne',
        'brisbane'=>'Australia/Brisbane','perth'=>'Australia/Perth',
        'adelaide'=>'Australia/Adelaide','darwin'=>'Australia/Darwin',
        'auckland'=>'Pacific/Auckland','wellington'=>'Pacific/Auckland',
        'christchurch'=>'Pacific/Auckland','hamilton'=>'Pacific/Auckland',
        'honolulu'=>'Pacific/Honolulu','suva'=>'Pacific/Fiji',
        'port moresby'=>'Pacific/Port_Moresby','noumea'=>'Pacific/Noumea',
        'papeete'=>'Pacific/Tahiti','nuku alofa'=>'Pacific/Tongatapu',
        /* Pacific */
        'dili'=>'Asia/Dili',
    ];

    /* ── Single-timezone countries ───────────────────────── */
    $COUNTRY_TZ = [
        'france'=>'Europe/Paris','germany'=>'Europe/Berlin',
        'united kingdom'=>'Europe/London','ireland'=>'Europe/Dublin',
        'portugal'=>'Europe/Lisbon',
        'netherlands'=>'Europe/Amsterdam','belgium'=>'Europe/Brussels',
        'luxembourg'=>'Europe/Luxembourg','switzerland'=>'Europe/Zurich',
        'austria'=>'Europe/Vienna','liechtenstein'=>'Europe/Vaduz',
        'spain'=>'Europe/Madrid','italy'=>'Europe/Rome',
        'denmark'=>'Europe/Copenhagen','sweden'=>'Europe/Stockholm',
        'norway'=>'Europe/Oslo','finland'=>'Europe/Helsinki',
        'iceland'=>'Atlantic/Reykjavik',
        'poland'=>'Europe/Warsaw','czech republic'=>'Europe/Prague',
        'czechia'=>'Europe/Prague','slovakia'=>'Europe/Bratislava',
        'hungary'=>'Europe/Budapest','romania'=>'Europe/Bucharest',
        'bulgaria'=>'Europe/Sofia','greece'=>'Europe/Athens',
        'croatia'=>'Europe/Zagreb','slovenia'=>'Europe/Ljubljana',
        'serbia'=>'Europe/Belgrade','bosnia and herzegovina'=>'Europe/Sarajevo',
        'north macedonia'=>'Europe/Skopje','albania'=>'Europe/Tirane',
        'moldova'=>'Europe/Chisinau','estonia'=>'Europe/Tallinn',
        'latvia'=>'Europe/Riga','lithuania'=>'Europe/Vilnius',
        'belarus'=>'Europe/Minsk','ukraine'=>'Europe/Kiev',
        'turkey'=>'Europe/Istanbul',
        'israel'=>'Asia/Jerusalem','jordan'=>'Asia/Amman',
        'lebanon'=>'Asia/Beirut','syria'=>'Asia/Damascus',
        'iraq'=>'Asia/Baghdad','iran'=>'Asia/Tehran',
        'saudi arabia'=>'Asia/Riyadh','qatar'=>'Asia/Qatar',
        'bahrain'=>'Asia/Bahrain','kuwait'=>'Asia/Kuwait',
        'oman'=>'Asia/Muscat','yemen'=>'Asia/Aden',
        'united arab emirates'=>'Asia/Dubai',
        'india'=>'Asia/Kolkata','pakistan'=>'Asia/Karachi',
        'bangladesh'=>'Asia/Dhaka','sri lanka'=>'Asia/Colombo',
        'nepal'=>'Asia/Kathmandu','bhutan'=>'Asia/Thimphu',
        'maldives'=>'Indian/Maldives','afghanistan'=>'Asia/Kabul',
        'singapore'=>'Asia/Singapore','brunei'=>'Asia/Brunei',
        'cambodia'=>'Asia/Bangkok','laos'=>'Asia/Vientiane',
        'myanmar'=>'Asia/Rangoon','vietnam'=>'Asia/Ho_Chi_Minh',
        'thailand'=>'Asia/Bangkok',
        'japan'=>'Asia/Tokyo','south korea'=>'Asia/Seoul',
        'north korea'=>'Asia/Pyongyang','taiwan'=>'Asia/Taipei',
        'mongolia'=>'Asia/Ulaanbaatar',
        'hong kong'=>'Asia/Hong_Kong','macau'=>'Asia/Macau',
        'philippines'=>'Asia/Manila','timor-leste'=>'Asia/Dili',
        'georgia'=>'Asia/Tbilisi','armenia'=>'Asia/Yerevan',
        'azerbaijan'=>'Asia/Baku','cyprus'=>'Asia/Nicosia',
        'egypt'=>'Africa/Cairo','libya'=>'Africa/Tripoli',
        'tunisia'=>'Africa/Tunis','algeria'=>'Africa/Algiers',
        'morocco'=>'Africa/Casablanca','western sahara'=>'Africa/El_Aaiun',
        'senegal'=>'Africa/Dakar','guinea'=>'Africa/Conakry',
        'sierra leone'=>'Africa/Freetown','ghana'=>'Africa/Accra',
        'togo'=>'Africa/Lome','benin'=>'Africa/Porto-Novo',
        'nigeria'=>'Africa/Lagos','niger'=>'Africa/Niamey',
        'mali'=>'Africa/Bamako','burkina faso'=>'Africa/Ouagadougou',
        'ivory coast'=>'Africa/Abidjan','cote divoire'=>'Africa/Abidjan',
        'liberia'=>'Africa/Monrovia','guinea-bissau'=>'Africa/Bissau',
        'gambia'=>'Africa/Banjul','mauritania'=>'Africa/Nouakchott',
        'kenya'=>'Africa/Nairobi','tanzania'=>'Africa/Dar_es_Salaam',
        'uganda'=>'Africa/Kampala','rwanda'=>'Africa/Kigali',
        'burundi'=>'Africa/Bujumbura','ethiopia'=>'Africa/Addis_Ababa',
        'somalia'=>'Africa/Mogadishu','djibouti'=>'Africa/Djibouti',
        'eritrea'=>'Africa/Asmara','sudan'=>'Africa/Khartoum',
        'south sudan'=>'Africa/Juba','chad'=>'Africa/Ndjamena',
        'cameroon'=>'Africa/Douala','central african republic'=>'Africa/Bangui',
        'gabon'=>'Africa/Libreville','republic of the congo'=>'Africa/Brazzaville',
        'democratic republic of the congo'=>'Africa/Kinshasa',
        'angola'=>'Africa/Luanda','zambia'=>'Africa/Lusaka',
        'zimbabwe'=>'Africa/Harare','mozambique'=>'Africa/Maputo',
        'namibia'=>'Africa/Windhoek','botswana'=>'Africa/Gaborone',
        'south africa'=>'Africa/Johannesburg','lesotho'=>'Africa/Maseru',
        'eswatini'=>'Africa/Mbabane','madagascar'=>'Indian/Antananarivo',
        'mauritius'=>'Indian/Mauritius','reunion'=>'Indian/Reunion',
        'new zealand'=>'Pacific/Auckland','fiji'=>'Pacific/Fiji',
        'papua new guinea'=>'Pacific/Port_Moresby',
        'solomon islands'=>'Pacific/Guadalcanal','vanuatu'=>'Pacific/Efate',
        'new caledonia'=>'Pacific/Noumea','french polynesia'=>'Pacific/Tahiti',
        'tonga'=>'Pacific/Tongatapu','samoa'=>'Pacific/Apia',
        'cuba'=>'America/Havana','jamaica'=>'America/Jamaica',
        'haiti'=>'America/Port-au-Prince','dominican republic'=>'America/Santo_Domingo',
        'puerto rico'=>'America/Puerto_Rico',
        'guatemala'=>'America/Guatemala','belize'=>'America/Belize',
        'honduras'=>'America/Tegucigalpa','el salvador'=>'America/El_Salvador',
        'nicaragua'=>'America/Managua','costa rica'=>'America/Costa_Rica',
        'panama'=>'America/Panama','colombia'=>'America/Bogota',
        'venezuela'=>'America/Caracas','ecuador'=>'America/Guayaquil',
        'peru'=>'America/Lima','bolivia'=>'America/La_Paz',
        'paraguay'=>'America/Asuncion','uruguay'=>'America/Montevideo',
        'chile'=>'America/Santiago',
    ];

    /* 1. Direct city match */
    if (isset($CITY[$c])) return $CITY[$c];

    /* 2. Try region as city (handles "La Rochelle" → region might be "Charente-Maritime") */
    if ($r && isset($CITY[$r])) return $CITY[$r];

    /* 3. Partial match: city starts with a key or key starts with city */
    foreach ($CITY as $key => $tz) {
        if (strpos($c, $key) === 0 || strpos($key, $c) === 0) return $tz;
    }

    /* 4. Single-timezone country fallback */
    if (isset($COUNTRY_TZ[$co])) return $COUNTRY_TZ[$co];

    /* 5. Partial country match */
    foreach ($COUNTRY_TZ as $key => $tz) {
        if (strpos($co, $key) !== false || strpos($key, $co) !== false) return $tz;
    }

    return ''; /* unknown — JS will use device local time */
}

/* ── WEATHER — Open-Meteo primary, wttr.in fallback ──────── */
$city = trim($_GET['city'] ?? '');
if ($city !== '') {
    $weatherOk = false;

    /* ── 1. Open-Meteo (geocode → forecast, best city names + tz) ── */
    $geo = jget('https://geocoding-api.open-meteo.com/v1/search?name='
                .urlencode($city).'&count=1&language=en&format=json', 8);
    $gr  = $geo['results'][0] ?? null;
    if ($gr) {
        $lat         = (float)($gr['latitude']  ?? 0);
        $lng         = (float)($gr['longitude'] ?? 0);
        $cityName    = $gr['name']    ?? ucwords($city);
        $regionName  = $gr['admin1']  ?? '';
        $countryName = $gr['country'] ?? '';
        $tz_raw      = $gr['timezone'] ?? ''; /* IANA tz from geocoding */

        $om  = jget('https://api.open-meteo.com/v1/forecast'
                   .'?latitude='.$lat.'&longitude='.$lng
                   .'&current=temperature_2m,apparent_temperature'
                   .',relative_humidity_2m,wind_speed_10m,weather_code'
                   .'&wind_speed_unit=kmh&temperature_unit=celsius&timezone=auto', 10);
        $cur = $om['current'] ?? null;

        if ($cur) {
            $temp_c  = (int)round($cur['temperature_2m']       ?? 0);
            $feels_c = (int)round($cur['apparent_temperature']  ?? $temp_c);
            $humid   = (int)round($cur['relative_humidity_2m']  ?? 0);
            $wind    = (int)round($cur['wind_speed_10m']        ?? 0);
            $wmo     = (int)($cur['weather_code']               ?? 0);
            $temp_f  = (int)round($temp_c * 9/5 + 32);
            $feels_f = (int)round($feels_c * 9/5 + 32);
            $wmoMap  = [
                0=>['Clear sky',113],    1=>['Mainly clear',113],  2=>['Partly cloudy',116],
                3=>['Overcast',119],    45=>['Foggy',143],        48=>['Icy fog',143],
                51=>['Light drizzle',266],53=>['Drizzle',266],   55=>['Heavy drizzle',266],
                61=>['Slight rain',293], 63=>['Rain',296],        65=>['Heavy rain',302],
                71=>['Slight snow',323], 73=>['Snow',326],        75=>['Heavy snow',338],
                77=>['Snow grains',179], 80=>['Showers',176],     81=>['Showers',176],
                82=>['Heavy showers',356],85=>['Snow showers',179],86=>['Heavy snow showers',338],
                95=>['Thunderstorm',200],96=>['Thunderstorm+hail',386],99=>['Thunderstorm+hail',389],
            ];
            $tz = $tz_raw ?: resolveTimezone($cityName, $regionName, $countryName);
            $out['weather'] = [
                'city'     => $cityName,    'region'   => $regionName,
                'country'  => $countryName, 'lat'      => $lat, 'lng' => $lng,
                'timezone' => $tz,
                'temp_c'   => $temp_c,    'temp_f'   => $temp_f,
                'feels_c'  => $feels_c,   'feels_f'  => $feels_f,
                'humidity' => $humid,     'wind_kmh' => $wind,
                'desc'     => $wmoMap[$wmo][0] ?? 'Unknown',
                'code'     => $wmoMap[$wmo][1] ?? 113,
                'src'      => 'open-meteo',
            ];
            $weatherOk = true;
        }
    }

    /* ── 2. wttr.in fallback (if Open-Meteo fails) ─────────── */
    if (!$weatherOk) {
        $enc1 = str_replace('%20','+',urlencode($city));
        $enc2 = urlencode($city);
        $w = jget("https://wttr.in/{$enc1}?format=j1&lang=en", 12)
          ?? jget("https://wttr.in/{$enc2}?format=j1&lang=en", 10);
        if ($w && isset($w['current_condition'][0])) {
            $c    = $w['current_condition'][0];
            $area = $w['nearest_area'][0] ?? null;
            $cityName    = $area ? ($area['areaName'][0]['value']  ?? ucwords($city)) : ucwords($city);
            $regionName  = $area ? ($area['region'][0]['value']    ?? '') : '';
            $countryName = $area ? ($area['country'][0]['value']   ?? '') : '';
            $lat         = $area ? (float)($area['latitude']       ?? 0)  : 0;
            $lng         = $area ? (float)($area['longitude']      ?? 0)  : 0;
            $tz = resolveTimezone($cityName, $regionName, $countryName);
            $out['weather'] = [
                'city'     => $cityName,   'region'   => $regionName,
                'country'  => $countryName,'lat'      => $lat, 'lng' => $lng,
                'timezone' => $tz,
                'temp_c'   => (int)($c['temp_C']        ?? 0),
                'temp_f'   => (int)($c['temp_F']        ?? 32),
                'feels_c'  => (int)($c['FeelsLikeC']    ?? 0),
                'feels_f'  => (int)($c['FeelsLikeF']    ?? 32),
                'humidity' => (int)($c['humidity']       ?? 0),
                'wind_kmh' => (int)($c['windspeedKmph']  ?? 0),
                'desc'     => $c['weatherDesc'][0]['value'] ?? '',
                'code'     => (int)($c['weatherCode']   ?? 113),
                'src'      => 'wttr',
            ];
            $weatherOk = true;
        }
    }

    if (!$weatherOk) {
        $out['weather_error'] = $city;
        $errors['weather']    = 'all sources failed';
    }
}

/* ── MEMPOOL (sequential, all via file_get_contents) ─────── */
$fees = jget('https://mempool.space/api/v1/fees/recommended');
if ($fees) {
    $out['fees'] = [
        'fastest' => $fees['fastestFee']  ?? null,
        'hour'    => $fees['hourFee']     ?? null,
        'economy' => $fees['economyFee']  ?? null,
        'minimum' => $fees['minimumFee']  ?? null,
    ];
    $out['ok'] = true;
}

$ht = grabText('https://mempool.space/api/blocks/tip/height');
if ($ht && ctype_digit($ht)) $out['height'] = (int)$ht;

/* Fetch latest block — try /v1/blocks/tip first (returns array),
   fall back to tip/hash + /block/{hash} if array doesn't include timestamp */
$blocks = jget('https://mempool.space/api/v1/blocks/tip', 8);
$b0 = null;
if ($blocks && is_array($blocks) && isset($blocks[0]) && is_array($blocks[0])) {
    $b0 = $blocks[0];
}
if ($b0 && !empty($b0['timestamp'])) {
    $out['block'] = [
        'timestamp' => (int)$b0['timestamp'],
        'size'      => (int)($b0['size']     ?? 0),
        'tx_count'  => (int)($b0['tx_count'] ?? 0),
    ];
} else {
    /* fallback: get hash → fetch full block object */
    $hash = grabText('https://mempool.space/api/blocks/tip/hash', 6);
    if ($hash && preg_match('/^[0-9a-f]{64}$/', $hash)) {
        $blk = jget("https://mempool.space/api/block/{$hash}", 8);
        if ($blk && !empty($blk['timestamp'])) {
            $out['block'] = [
                'timestamp' => (int)$blk['timestamp'],
                'size'      => (int)($blk['size']     ?? 0),
                'tx_count'  => (int)($blk['tx_count'] ?? 0),
            ];
        }
    }
}

$mem = jget('https://mempool.space/api/mempool');
if ($mem) $out['mempool'] = ['count' => $mem['count'] ?? null];

/* ── MINING STATS — hashrate + difficulty, cached 10 min ─── */
$mining = jcache('https://mempool.space/api/v1/mining/hashrate/3d', 'bb_mining', 600, 10);
if ($mining && isset($mining['currentHashrate'])) {
    $out['mining'] = [
        'hashrate'   => (float)$mining['currentHashrate'],   /* H/s */
        'difficulty' => (float)$mining['currentDifficulty'],
    ];
}

/* ── CIRCULATING SUPPLY ───────────────────────────────────── */
if (isset($out['height'])) {
    $h = $out['height']; $s = 0.0; $sub = 50.0; $rem = $h;
    while ($rem > 0 && $sub >= 1e-8) {
        $n = min($rem, 210000); $s += $n * $sub; $rem -= $n; $sub /= 2;
    }
    $out['supply'] = round($s, 2);
}

/* ── PRICE: Kraken → Bitstamp → CoinGecko ────────────────── */
$price = null;

/* 1. Kraken */
$kr = jget('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,XBTEUR', 8);
if ($kr && empty($kr['error']) && isset($kr['result'])) {
    $res  = $kr['result'];
    $usdt = $res['XXBTZUSD'] ?? $res['XBTUSD'] ?? null;
    $eurt = $res['XXBTZEUR'] ?? $res['XBTEUR'] ?? null;
    if ($usdt && !empty($usdt['c'][0])) {
        $usd  = (float)$usdt['c'][0];
        $open = (float)($usdt['o'] ?? $usd);
        $price = [
            'usd'     => $usd,
            'eur'     => $eurt ? (float)$eurt['c'][0] : null,
            'chg24h'  => $open > 0 ? round(($usd-$open)/$open*100, 2) : 0,
            'vol24h'  => (float)($usdt['v'][1] ?? 0) * $usd,
            'high24h' => (float)($usdt['h'][1] ?? 0),
            'low24h'  => (float)($usdt['l'][1] ?? 0),
            'src'     => 'kraken',
        ];
    } else $errors['kraken'] = 'no price in result';
} else $errors['kraken'] = 'fetch failed';

/* 2. Bitstamp */
if (!$price) {
    $bsu = jget('https://www.bitstamp.net/api/v2/ticker/btcusd/', 8);
    $bse = jget('https://www.bitstamp.net/api/v2/ticker/btceur/', 8);
    if ($bsu && !empty($bsu['last'])) {
        $usd  = (float)$bsu['last'];
        $open = (float)($bsu['open'] ?? $usd);
        $price = [
            'usd'     => $usd,
            'eur'     => $bse ? (float)$bse['last'] : null,
            'chg24h'  => $open > 0 ? round(($usd-$open)/$open*100, 2) : 0,
            'vol24h'  => (float)($bsu['volume'] ?? 0) * $usd,
            'high24h' => (float)($bsu['high']   ?? 0),
            'low24h'  => (float)($bsu['low']    ?? 0),
            'src'     => 'bitstamp',
        ];
    } else $errors['bitstamp'] = 'fetch failed';
}

/* 3. CoinGecko — cached 5 min, last resort */
if (!$price) {
    $cg = jcache(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur&include_24hr_change=true&include_24hr_vol=true',
        'cg_price', 300
    );
    if ($cg && !empty($cg['bitcoin']['usd'])) {
        $b = $cg['bitcoin'];
        $price = [
            'usd'     => (float)$b['usd'],
            'eur'     => (float)($b['eur'] ?? 0),
            'chg24h'  => (float)($b['usd_24h_change'] ?? 0),
            'vol24h'  => (float)($b['usd_24h_vol']    ?? 0),
            'high24h' => null,
            'low24h'  => null,
            'src'     => 'coingecko',
        ];
    } else $errors['coingecko'] = 'failed';
}

if ($price) { $out['price'] = $price; $out['ok'] = true; }

/* ── ETF FLOWS — bitbo.io primary (farside blocks host), skip zeros, newest-first ── */

function parseEtfHtml(string $html, string $src): ?array {
    libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    $dom->loadHTML($html);
    libxml_clear_errors();
    $xpath = new DOMXPath($dom);
    $rows      = $xpath->query('//table//tr');
    $col_total = null;
    $best_usd  = null;
    $best_date = null;
    $SKIP = ['total','average','maximum','minimum','total net flow'];
    foreach ($rows as $row) {
        $ths = $row->getElementsByTagName('th');
        if ($ths->length > 0) {
            foreach ($ths as $j => $th) {
                $t = strtolower(trim($th->textContent));
                if ($t === 'total' || $t === 'totals') $col_total = $j;
            }
            continue;
        }
        $tds = $row->getElementsByTagName('td');
        if ($tds->length < 3) continue;
        $first = trim($tds->item(0)->textContent ?? '');
        if (in_array(strtolower($first), $SKIP, true)) continue;
        /* Accept both date formats:
           bitbo:   "Mar 19, 2026" or "March 19, 2026"
           farside: "19 Mar 2026" */
        $is_date = preg_match('/\d{1,2}\s+\w+\s+\d{4}/', $first)
                || preg_match('/\w+\s+\d{1,2},?\s*\d{4}/', $first);
        if (!$is_date) continue;
        $tcol = $col_total ?? ($tds->length - 1);
        $raw  = trim($tds->item($tcol)->textContent ?? '');
        $val  = str_replace([',', '$', ' ', "\xc2\xa0"], '', $raw);
        if (!is_numeric($val))  continue;
        if ((float)$val == 0.0) continue;  /* skip zero = weekend/unpublished */
        $best_usd  = (float)$val * 1e6;
        $best_date = $first;
        if ($src === 'bitbo') break;  /* bitbo is newest-first: stop at first non-zero */
    }
    if ($best_usd === null) return null;
    return ['flow_usd' => $best_usd, 'date' => $best_date, 'src' => $src];
}

$etf_cf  = sys_get_temp_dir().'/bb_etf_flows.json';
$etf_ttl = 7200; /* 2 hours */

if (!file_exists($etf_cf) || (time() - filemtime($etf_cf)) > $etf_ttl) {
    $etf_parsed = null;
    /* 1. Bitbo — primary (reliable from this host, newest-first table) */
    $bb_html = fget('https://bitbo.io/treasuries/etf-flows/', 15);
    if ($bb_html && strlen($bb_html) > 2000) {
        $etf_parsed = parseEtfHtml($bb_html, 'bitbo');
    }
    /* 2. Farside — fallback (blocks some hosts, oldest-first table) */
    if (!$etf_parsed) {
        $fs_html = fget('https://farside.co.uk/btc/', 15);
        if ($fs_html && strlen($fs_html) > 2000) {
            $etf_parsed = parseEtfHtml($fs_html, 'farside');
        }
    }
    if ($etf_parsed) {
        file_put_contents($etf_cf, json_encode($etf_parsed));
    }
}
if (file_exists($etf_cf)) {
    $etf_cached = json_decode(file_get_contents($etf_cf), true);
    if ($etf_cached) $out['etf'] = $etf_cached;
}

/* ── MCAP + DOMINANCE — CoinGecko cached 10 min ──────────── */
$cg2 = jcache(
    'https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false',
    'cg_btc', 600
);
/* Dominance lives in /global, not /coins/bitcoin */
$cg_global = jcache('https://api.coingecko.com/api/v3/global', 'cg_global', 600);
$btc_dom = $cg_global['data']['market_cap_percentage']['btc'] ?? null;

if ($cg2 && isset($cg2['market_data'])) {
    $m = $cg2['market_data'];
    $out['detail'] = [
        'mcap'     => $m['market_cap']['usd']    ?? null,
        'dom'      => $btc_dom,
        'high24h'  => $m['high_24h']['usd']      ?? null,
        'low24h'   => $m['low_24h']['usd']        ?? null,
        'totvol'   => $m['total_volume']['usd']  ?? null,
    ];
    if ($price && (!$price['high24h'] || !$price['low24h'])) {
        $price['high24h'] = $m['high_24h']['usd']  ?? null;
        $price['low24h']  = $m['low_24h']['usd']   ?? null;
        $out['price'] = $price;
    }
} elseif ($btc_dom !== null) {
    if (!isset($out['detail'])) $out['detail'] = [];
    $out['detail']['dom'] = $btc_dom;
}
if (!empty($errors)) $out['_errors'] = $errors;

/* ── BLOCKBOARD PULSE — proprietary sentiment index, cached 1h ──────────────
   Formula (no external F&G dependency):
   1. volScore  (30%) — volatility: high range = fear (inverted)
                        range = (high24h - low24h) / price
                        bornes: 1% = calm (100) → 10% = panic (0)
   2. momScore  (45%) — momentum: composite of MA30 position + 24h direction
      momMA     (70%) — price vs 30-day moving average (from cached OHLC 1m)
                        ±20% around MA maps to 0–100
      momDelta  (30%) — 24h change: ±10% maps to 0–100
   3. domScore  (25%) — BTC dominance: 45%→0, 65%→100 (ETF-adjusted baseline)
   All inputs already fetched above (Kraken price, CoinGecko global).
   Cache: 1h in /tmp/bb_pulse.json — recalculates if stale.
   ───────────────────────────────────────────────────────────────────────── */
$pulse_cf  = sys_get_temp_dir() . '/bb_pulse.json';
$pulse_ttl = 3600; /* 1 hour */
$pulse_ok  = false;

/* Try serving from cache first */
if (file_exists($pulse_cf) && (time() - filemtime($pulse_cf)) < $pulse_ttl) {
    $cached_pulse = @json_decode(file_get_contents($pulse_cf), true);
    if ($cached_pulse && isset($cached_pulse['value'])) {
        $out['fg'] = $cached_pulse;
        $pulse_ok  = true;
    }
}

if (!$pulse_ok) {
    /* ── 1. VOLATILITY SCORE ──────────────────────────────────── */
    $p_usd  = $out['price']['usd']    ?? 0;
    $p_hi   = $out['price']['high24h'] ?? ($out['detail']['high24h'] ?? 0);
    $p_lo   = $out['price']['low24h']  ?? ($out['detail']['low24h']  ?? 0);
    $p_chg  = $out['price']['chg24h']  ?? 0;   /* % e.g. -3.1 */

    $vol_score = 50; /* default neutral */
    if ($p_usd > 0 && $p_hi > 0 && $p_lo > 0) {
        $range_pct = ($p_hi - $p_lo) / $p_usd; /* e.g. 0.04 = 4% */
        /* 1% range → score 100 (calm/greed), 10% range → score 0 (panic/fear) */
        $vol_raw   = ($range_pct - 0.01) / 0.09 * 100;
        $vol_score = max(0, min(100, round(100 - $vol_raw)));
    }

    /* ── 2. MOMENTUM SCORE ───────────────────────────────────── */
    /* MA30: compute from cached OHLC 1m candles (35 daily closes) */
    $ma30 = 0;
    $ohlc_file = sys_get_temp_dir() . '/bb_ohlc_1m.json';
    if (file_exists($ohlc_file)) {
        $ohlc_data = @json_decode(file_get_contents($ohlc_file), true);
        if (!empty($ohlc_data['ohlc']) && count($ohlc_data['ohlc']) >= 5) {
            $closes = array_column($ohlc_data['ohlc'], 4); /* close prices */
            $ma30   = round(array_sum($closes) / count($closes), 2);
        }
    }
    /* Fallback: estimate MA30 from current price if cache missing */
    if ($ma30 <= 0 && $p_usd > 0) {
        /* Conservative estimate: current price is slightly above MA in recovery */
        $ma30 = $p_usd * 0.94;
    }

    /* momMA: position of price vs MA30, ±20% maps to 0–100 */
    $mom_ma = 50;
    if ($ma30 > 0 && $p_usd > 0) {
        $dev    = ($p_usd - $ma30) / $ma30; /* e.g. +0.079 = +7.9% above MA */
        $mom_ma = max(0, min(100, round(50 + ($dev / 0.20) * 50)));
    }

    /* momDelta: 24h change, ±10% maps to 0–100 */
    $mom_delta = max(0, min(100, round(50 + ($p_chg / 10) * 50)));

    /* Combined momentum */
    $mom_score = round(0.70 * $mom_ma + 0.30 * $mom_delta);

    /* ── 3. DOMINANCE SCORE ──────────────────────────────────── */
    $dom_score = 50; /* neutral default */
    $btc_dom_val = $out['detail']['dom'] ?? null;
    if ($btc_dom_val !== null) {
        /* 45% dom → 0 (altseason/risk-on), 65% dom → 100 (BTC dominance/risk-off)
           ETF-adjusted: 57% ≈ neutral/slightly bullish */
        $dom_score = max(0, min(100, round(($btc_dom_val - 45) / 20 * 100)));
    }

    /* ── FINAL PULSE SCORE ───────────────────────────────────── */
    $pulse_value = round(0.30 * $vol_score + 0.45 * $mom_score + 0.25 * $dom_score);

    /* Label mapping */
    $pulse_label = match(true) {
        $pulse_value <= 24  => 'Flatlined',
        $pulse_value <= 44  => 'Fading',
        $pulse_value <= 55  => 'Chill',
        $pulse_value <= 74  => 'HODLing',
        default             => 'Mooning',
    };

    $pulse_out = [
        'value'  => $pulse_value,
        'label'  => $pulse_label,
        'source' => 'blockboard',
        /* debug breakdown — remove in prod if desired */
        '_v'     => $vol_score,
        '_m'     => $mom_score,
        '_d'     => $dom_score,
        '_ma30'  => $ma30,
    ];

    /* Cache to disk */
    @file_put_contents($pulse_cf, json_encode($pulse_out));

    $out['fg'] = $pulse_out;
}

/* ── LIGHTNING NETWORK — 1ml.com cached 1h ───────────────── */
$ln = jcache('https://1ml.com/statistics?json=true', 'ln_stats', 3600, 8);
if ($ln) {
    $out['ln'] = [
        'nodes'     => (int)($ln['numberofnodes']    ?? 0),
        'nodes_30d' => round((float)($ln['numberofnodes30dchange'] ?? 0), 1),
        'channels'  => (int)($ln['numberofchannels']  ?? 0),
        'chan_30d'  => round((float)($ln['numberofchannels30dchange'] ?? 0), 1),
        /* networkcapacity is in satoshis */
        'cap_btc'   => isset($ln['networkcapacity']) ? round((float)$ln['networkcapacity'] / 1e8, 0) : null,
        'cap_30d'   => isset($ln['networkcapacity30dchange']) ? round((float)$ln['networkcapacity30dchange'], 1) : null,
    ];
}

ob_end_clean(); /* clear any stray output */
echo json_encode($out, JSON_UNESCAPED_SLASHES);

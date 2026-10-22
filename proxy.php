<?php
// Proxy baca-saja ke API Meteora, dipakai hanya jika browser memblokir panggilan langsung (CORS).
// Hanya GET ke dlmm.datapi.meteora.ag yang diizinkan.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$u = isset($_GET['u']) ? $_GET['u'] : '';
$p = parse_url($u);
if (!$p || ($p['scheme'] ?? '') !== 'https' || ($p['host'] ?? '') !== 'dlmm.datapi.meteora.ag' || isset($p['user']) || isset($p['port'])) {
  http_response_code(400); echo '{"error":"url tidak diizinkan"}'; exit;
}
$ch = curl_init($u);
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 20, CURLOPT_HTTPHEADER => ['Accept: application/json'], CURLOPT_MAXFILESIZE => 5000000]);
$body = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
if ($body === false) { http_response_code(502); echo '{"error":"gagal menghubungi Meteora"}'; exit; }
http_response_code($code ?: 502);
echo $body;

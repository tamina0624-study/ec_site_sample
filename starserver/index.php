<?php
declare(strict_types=1);
// Server-to-server endpoint. Never put credentials or PPTX files in public_html.
ini_set('display_errors', '0');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function respond(int $status, array $value): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($value, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    exit;
}
function bad(int $status = 400): void { respond($status, ['error' => 'Request rejected']); }

try {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') bad(405);
    // Browsers are not clients of this endpoint. No CORS permissions are emitted.
    if (isset($_SERVER['HTTP_ORIGIN'])) bad(403);
    if (($_SERVER['HTTPS'] ?? '') !== 'on' && ($_SERVER['SERVER_PORT'] ?? '') !== '443') bad(403);
    $configPath = dirname(__DIR__, 2) . '/slide-market-private/config.php';
    if (!is_file($configPath)) bad(503);
    $config = require $configPath;
    $secret = $config['api_key'] ?? '';
    if (!is_string($secret) || strlen($secret) < 32 || strpos($secret, 'REPLACE_') === 0) bad(503);
    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (!hash_equals('Bearer ' . $secret, $authorization)) bad(401);
    $action = $_GET['action'] ?? '';
    if (!in_array($action, ['revision','sql','read-file','write-file','read-preview','write-preview'], true)) bad(404);
    $input = fopen('php://input', 'rb');
    if ($input === false) bad(400);
    $isFile = strpos($action, 'file') !== false || strpos($action, 'preview') !== false;
    $max = $isFile ? min(50 * 1024 * 1024, (int)($config['max_file_bytes'] ?? 0)) + 128 : 2 * 1024 * 1024;
    if ($max < 129) bad(503);
    $bytes = stream_get_contents($input, $max + 1);
    if ($bytes === false || strlen($bytes) > $max) bad(413);
    if ($isFile) {
        $lines = explode("\n", $bytes, $action === 'write-preview' ? 3 : 2);
        $checksum = $lines[0];
        if (!preg_match('/^[a-f0-9]{64}$/D', $checksum)) bad();
        $preview = strpos($action, 'preview') !== false;
        $index = $preview ? ($lines[1] ?? '') : '';
        if ($preview && !preg_match('/^(?:[0-9]|1[01])$/D', $index)) bad();
        $root = realpath($config['storage_dir']);
        $public = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
        if ($root === false || $public === false || $root === $public || strpos($root, $public . DIRECTORY_SEPARATOR) === 0) bad(503);
        $directory = $root . ($preview ? '/previews/' . $checksum : '/versions');
        $path = $directory . '/' . ($preview ? $index . '.png' : $checksum . '.pptx');
        if (strpos($action, 'write-') === 0) {
            $payload = $preview ? ($lines[2] ?? '') : ($lines[1] ?? '');
            if ($payload === '' || strlen($payload) > ($preview ? min(10 * 1024 * 1024, $max - 128) : $max - 128)) bad(413);
            if ($preview ? substr($payload, 0, 8) !== "\x89PNG\r\n\x1a\n" : !hash_equals($checksum, hash('sha256', $payload))) bad();
            // PPTX inspection/scanning is performed by Node before upload.
            if (!$preview && substr($payload, 0, 2) !== 'PK') bad();
            if (!is_dir($directory) && !mkdir($directory, 0700, true)) bad(503);
            $temporary = tempnam($directory, '.upload-');
            if ($temporary === false) bad(503);
            try {
                if (file_put_contents($temporary, $payload, LOCK_EX) !== strlen($payload)) bad(503);
                chmod($temporary, 0600);
                if (!rename($temporary, $path)) bad(503);
            } finally { if (is_file($temporary)) unlink($temporary); }
            respond(200, ['ok' => true]);
        }
        if (!is_file($path)) bad(404);
        if (!$preview && !hash_equals($checksum, hash_file('sha256', $path))) bad(503);
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . filesize($path));
        readfile($path);exit;
    }
    $request = json_decode($bytes, true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($request)) bad();
    $pdo = new PDO($config['dsn'], $config['user'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    if ($action === 'revision') respond(200, ['revision' => (int)$pdo->query('SELECT revision FROM storage_revision WHERE id=1')->fetchColumn()]);
    $operations = $request['operations'] ?? null;
    if (!is_array($operations) || count($operations) > 500) bad();
    $pdo->beginTransaction();
    try {
        $revision = (int)$pdo->query('SELECT revision FROM storage_revision WHERE id=1 FOR UPDATE')->fetchColumn();
        if (isset($request['expectedRevision']) && (!is_int($request['expectedRevision']) || $revision !== $request['expectedRevision'])) {
            $pdo->rollBack();bad(409);
        }
        $results = []; $changed = false;
        foreach ($operations as $op) {
            if (!is_array($op)) bad();
            $sql = $op['sql'] ?? ''; $params = $op['params'] ?? null; $mode = $op['mode'] ?? '';
            if (!is_string($sql) || strlen($sql) > 8192 || !is_array($params) || count($params) > 30 || !in_array($mode, ['get','all','run'], true)) bad();
            // This bearer-authenticated endpoint is an internal DB adapter, not a public query API.
            // Only data operations on this app's tables are accepted; no DDL, files, procedures or multi-statements.
            if (!preg_match('/^(SELECT|INSERT(?: IGNORE)? INTO|UPDATE|DELETE FROM)\b/i', $sql) || preg_match('/;|--|\/\*|\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|LOAD_FILE|SLEEP|BENCHMARK|UNION|INFORMATION_SCHEMA|MYSQL|PERFORMANCE_SCHEMA|STORAGE_REVISION)\b/i', $sql)) bad();
            preg_match_all('/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/i', $sql, $matches);
            foreach ($matches[1] as $table) {
                // ON DUPLICATE KEY UPDATE value=... / count=... are not table references.
                if (!in_array(strtolower($table), ['sessions','orders','items','documents','favorites','metrics','value','count'], true)) bad();
            }
            $read = preg_match('/^SELECT\b/i', $sql) === 1;
            if ($read === ($mode === 'run')) bad();
            foreach ($params as $parameter) if (!is_null($parameter) && !is_scalar($parameter)) bad();
            $statement = $pdo->prepare($sql);
            foreach (array_values($params) as $i => $parameter) $statement->bindValue($i + 1, $parameter, is_int($parameter) ? PDO::PARAM_INT : (is_null($parameter) ? PDO::PARAM_NULL : PDO::PARAM_STR));
            $statement->execute();
            $results[] = $mode === 'all' ? $statement->fetchAll() : ($mode === 'get' ? ($statement->fetch() ?: null) : ['changes' => $statement->rowCount()]);
            if (!$read) $changed = true;
        }
        if ($changed) $pdo->exec('UPDATE storage_revision SET revision=revision+1 WHERE id=1');
        $pdo->commit();respond(200, ['results' => $results]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        if ($e instanceof PDOException && (string)$e->getCode() === '23000') bad(409);
        throw $e;
    }
} catch (Throwable $e) {
    // Never return DB credentials, SQL, paths, or request bodies to callers.
    respond(503, ['error' => 'Storage unavailable']);
}

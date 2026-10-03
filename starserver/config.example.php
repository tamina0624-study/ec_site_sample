<?php
// Copy as config.php OUTSIDE the public document root.
// Default layout: public_html/slide-market/index.php and slide-market-private/config.php
return [
    'dsn' => 'mysql:host=MYSQL_HOST;dbname=MYSQL_DATABASE;charset=utf8mb4',
    'user' => 'MYSQL_USER',
    'password' => 'MYSQL_PASSWORD',
    // Use the same random 32+ character key as STARSERVER_API_KEY on Render.
    'api_key' => 'REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARACTERS',
    'storage_dir' => __DIR__ . '/files',
    // Adjust to StarServer's PHP memory, HTTP body and execution limits.
    // Application hard limit remains 50 MB; a lower host limit may reject earlier.
    'max_file_bytes' => 50 * 1024 * 1024,
];

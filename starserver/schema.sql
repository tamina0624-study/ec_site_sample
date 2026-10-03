-- Import once using StarServer's database administration tool (MySQL 5.7+ / MariaDB).
-- All tables must use InnoDB: revision checks and order writes share a transaction.
CREATE TABLE IF NOT EXISTS storage_revision (
 id INT PRIMARY KEY, revision BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
INSERT IGNORE INTO storage_revision VALUES (1,0);

-- Historical name: these rows are durable owner IDs, not browser sessions.
CREATE TABLE IF NOT EXISTS sessions (
 id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS orders (
 id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 session_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 date VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 total INT NOT NULL,
 request_key VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
 request_body TEXT NOT NULL,
 UNIQUE KEY owner_request (session_id,request_key),
 KEY owner_date (session_id,date,id),
 FOREIGN KEY (session_id) REFERENCES sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS items (
 order_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 product_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 name VARCHAR(100) NOT NULL,
 price INT NOT NULL,
 PRIMARY KEY (order_id,product_id),
 FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS documents (
 seq BIGINT UNSIGNED AUTO_INCREMENT UNIQUE,
 kind VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 value LONGTEXT NOT NULL,
 PRIMARY KEY (kind,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS favorites (
 session_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 product_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY (session_id,product_id),
 FOREIGN KEY (session_id) REFERENCES sessions(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS metrics (
 day VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 event VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 count BIGINT NOT NULL,
 PRIMARY KEY (day,event)
) ENGINE=InnoDB;

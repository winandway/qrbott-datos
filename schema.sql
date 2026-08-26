-- =====================================================================
-- QRbott — esquema de la base en YaDominios Cloud (SQLite / D1)
-- GENERADO desde la estructura real de Supabase. No editar a mano:
-- se regenera con scripts/generar-esquema.mjs y se vuelve a publicar.
--
-- OJO, LO MÁS IMPORTANTE: SQLite NO tiene seguridad por filas. Aquí no hay
-- ni una política. La frontera que impide que una tienda vea los datos de
-- otra vive en la capa de acceso del worker (`_worker.js`), que añade el
-- filtro de tienda a TODA consulta. Por eso cada tabla de negocio lleva su
-- `bot_id` y hay un índice por él.
-- =====================================================================

-- ---------- Familia: catalogo ----------

CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  prompt TEXT,
  personality TEXT DEFAULT 'amigable',
  language TEXT DEFAULT 'es',
  status TEXT DEFAULT 'inactive',
  avatar_url TEXT,
  welcome_message TEXT DEFAULT 'Hola! ¿En qué puedo ayudarte?',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  slug TEXT,
  industry_template_id TEXT,
  bot_type TEXT DEFAULT 'general',
  system_prompt TEXT,
  currency_code TEXT DEFAULT 'USD',
  currency_symbol TEXT DEFAULT '$',
  currency_decimals INTEGER DEFAULT 2,
  currency_name TEXT DEFAULT 'Dólar Estadounidense',
  currency_position TEXT DEFAULT 'before',
  fanpage_enabled INTEGER DEFAULT 0,
  cover_image_url TEXT,
  bio TEXT,
  social_links TEXT DEFAULT '{}',
  contact_email TEXT,
  contact_phone TEXT,
  business_category TEXT,
  business_address TEXT,
  business_hours TEXT DEFAULT '{}',
  theme_colors TEXT,
  benefits TEXT DEFAULT '[]',
  fanpage_template TEXT DEFAULT 'classic',
  tagline TEXT,
  is_open INTEGER DEFAULT 1,
  is_suspended INTEGER DEFAULT 0,
  suspended_at TEXT,
  suspension_reason TEXT,
  admin_contact_email TEXT,
  admin_contact_phone TEXT,
  store_type TEXT NOT NULL DEFAULT 'showbot',
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_name TEXT NOT NULL DEFAULT 'IVA',
  mercatren_connected INTEGER NOT NULL DEFAULT 0,
  mercatren_store_slug TEXT,
  mercatren_sync_activa INTEGER NOT NULL DEFAULT 1,
  modo_tienda TEXT NOT NULL DEFAULT 'completa'
);

CREATE TABLE IF NOT EXISTS sucursales (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  tipo_negocio TEXT NOT NULL DEFAULT 'general',
  direccion TEXT,
  telefono TEXT,
  activa INTEGER NOT NULL DEFAULT 1,
  es_principal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sucursales_bot_idx ON sucursales (bot_id);

CREATE TABLE IF NOT EXISTS bot_knowledge_base (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  knowledge_type TEXT NOT NULL,
  product_name TEXT,
  product_price REAL,
  product_description TEXT,
  product_image_url TEXT,
  product_category TEXT,
  question TEXT,
  answer TEXT,
  business_data TEXT,
  document_url TEXT,
  document_summary TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  product_image_thumbnail TEXT,
  product_image_medium TEXT,
  product_stock REAL DEFAULT 0,
  initial_stock REAL,
  total_sold REAL DEFAULT 0,
  stock_last_updated TEXT DEFAULT (datetime('now')),
  product_badge TEXT,
  product_badge_color TEXT,
  product_discount INTEGER DEFAULT 0,
  product_original_price REAL,
  product_sumup_link TEXT,
  product_tax_rate REAL,
  sale_type TEXT NOT NULL DEFAULT 'unit',
  unit_of_measure TEXT NOT NULL DEFAULT 'u',
  sucursal_id TEXT,
  product_barcode TEXT,
  sync_origin TEXT,
  mercatren_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS bot_knowledge_base_bot_idx ON bot_knowledge_base (bot_id);

CREATE TABLE IF NOT EXISTS bot_combos (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  combo_price REAL NOT NULL DEFAULT 0,
  sumup_link TEXT,
  items TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  position INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_combos_bot_idx ON bot_combos (bot_id);

CREATE TABLE IF NOT EXISTS bot_banners (
  id TEXT PRIMARY KEY,
  bot_id TEXT,
  title TEXT NOT NULL,
  subtitle TEXT,
  highlight TEXT,
  image_url TEXT,
  gradient TEXT DEFAULT 'linear-gradient(135deg, #667eea, #764ba2)',
  cta_text TEXT,
  cta_url TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  show_in_store INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_banners_bot_idx ON bot_banners (bot_id);

CREATE TABLE IF NOT EXISTS bot_coupons (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value REAL NOT NULL,
  valid_until TEXT,
  max_redemptions INTEGER,
  times_redeemed INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_coupons_bot_idx ON bot_coupons (bot_id);

CREATE TABLE IF NOT EXISTS bot_payment_methods (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  stripe_enabled INTEGER NOT NULL DEFAULT 0,
  stripe_public_key TEXT,
  stripe_secret_key TEXT,
  stripe_webhook_secret TEXT,
  stripe_currency TEXT DEFAULT 'usd',
  transfer_enabled INTEGER NOT NULL DEFAULT 0,
  bank_name TEXT,
  bank_account_number TEXT,
  bank_account_type TEXT,
  bank_holder_name TEXT,
  bank_holder_id TEXT,
  bank_additional_info TEXT,
  cash_enabled INTEGER NOT NULL DEFAULT 0,
  cash_instructions TEXT,
  require_shipping_address INTEGER NOT NULL DEFAULT 1,
  min_order_amount REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  terms_and_conditions TEXT,
  privacy_policy TEXT,
  refund_policy TEXT,
  return_days INTEGER DEFAULT 15,
  require_terms_acceptance INTEGER DEFAULT 1,
  store_contact_email TEXT,
  store_contact_phone TEXT,
  store_legal_name TEXT,
  store_address TEXT,
  timezone TEXT DEFAULT 'America/Mexico_City',
  store_country TEXT DEFAULT 'MX',
  stripe_test_mode INTEGER DEFAULT 1,
  sumup_enabled INTEGER NOT NULL DEFAULT 0,
  sumup_instructions TEXT,
  sumup_connected INTEGER NOT NULL DEFAULT 0,
  sumup_merchant_code TEXT
);
CREATE INDEX IF NOT EXISTS bot_payment_methods_bot_idx ON bot_payment_methods (bot_id);

CREATE TABLE IF NOT EXISTS bot_collaborators (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'editor',
  status TEXT NOT NULL DEFAULT 'active',
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_collaborators_bot_idx ON bot_collaborators (bot_id);

-- ---------- Familia: clientes ----------

CREATE TABLE IF NOT EXISTS pos_customers (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  document_id TEXT,
  notes TEXT,
  is_walk_in INTEGER NOT NULL DEFAULT 0,
  purchases_count INTEGER NOT NULL DEFAULT 0,
  total_spent REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pos_customers_bot_idx ON pos_customers (bot_id);

CREATE TABLE IF NOT EXISTS bot_customers (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  name TEXT,
  default_shipping_address TEXT,
  notes TEXT,
  total_orders INTEGER DEFAULT 0,
  total_spent REAL DEFAULT 0,
  first_order_at TEXT,
  last_order_at TEXT,
  status TEXT DEFAULT 'active',
  terms_accepted_at TEXT,
  privacy_accepted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_customers_bot_idx ON bot_customers (bot_id);

-- ---------- Familia: documentos ----------

CREATE TABLE IF NOT EXISTS documentos_comerciales (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  numero INTEGER NOT NULL,
  numero_texto TEXT NOT NULL,
  origen_id TEXT,
  cliente_nombre TEXT NOT NULL,
  cliente_tipo_doc TEXT,
  cliente_documento TEXT,
  cliente_telefono TEXT,
  cliente_direccion TEXT,
  cliente_correo TEXT,
  fecha TEXT NOT NULL,
  vence TEXT,
  moneda TEXT NOT NULL DEFAULT 'USD',
  tasa_bcv REAL,
  tasa_fecha TEXT,
  iva_pct REAL NOT NULL DEFAULT 16.00,
  subtotal REAL NOT NULL DEFAULT 0,
  iva_monto REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'borrador',
  notas TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS documentos_comerciales_bot_idx ON documentos_comerciales (bot_id);

CREATE TABLE IF NOT EXISTS documento_lineas (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  documento_id TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 1,
  producto_id TEXT,
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL DEFAULT 1,
  unidad TEXT NOT NULL DEFAULT 'u',
  precio REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS documento_lineas_bot_idx ON documento_lineas (bot_id);

CREATE TABLE IF NOT EXISTS documento_contadores (
  bot_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  ultimo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS documento_contadores_bot_idx ON documento_contadores (bot_id);

CREATE TABLE IF NOT EXISTS bot_datos_emisor (
  bot_id TEXT NOT NULL,
  razon_social TEXT,
  rif TEXT,
  direccion TEXT,
  telefonos TEXT,
  correo TEXT,
  sitio_web TEXT,
  logo_url TEXT,
  iva_por_defecto REAL NOT NULL DEFAULT 16.00,
  moneda TEXT NOT NULL DEFAULT 'USD',
  nota_pie TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_datos_emisor_bot_idx ON bot_datos_emisor (bot_id);

-- ---------- Familia: pedidos ----------

CREATE TABLE IF NOT EXISTS client_requests (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT,
  user_phone TEXT NOT NULL,
  user_name TEXT,
  request_content TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'nuevo',
  notification_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  order_source TEXT DEFAULT 'whatsapp',
  payment_method TEXT,
  payment_status TEXT DEFAULT 'pending',
  payment_proof_url TEXT,
  shipping_address TEXT,
  customer_id TEXT,
  customer_email TEXT,
  terms_accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS client_requests_bot_idx ON client_requests (bot_id);

-- ---------- Familia: pos ----------

CREATE TABLE IF NOT EXISTS pos_registers (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  opening_cash REAL NOT NULL DEFAULT 0,
  expected_cash REAL,
  closing_cash REAL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  sucursal_id TEXT
);
CREATE INDEX IF NOT EXISTS pos_registers_bot_idx ON pos_registers (bot_id);

CREATE TABLE IF NOT EXISTS pos_sales (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  register_id TEXT,
  customer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  receipt_number INTEGER NOT NULL,
  items TEXT NOT NULL,
  subtotal REAL NOT NULL,
  tax_total REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  payments TEXT NOT NULL DEFAULT '[]',
  delivery_mode TEXT NOT NULL DEFAULT 'counter',
  source TEXT NOT NULL DEFAULT 'pos',
  online_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  refund_of TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sucursal_id TEXT,
  client_ref TEXT,
  sold_offline_at TEXT
);
CREATE INDEX IF NOT EXISTS pos_sales_bot_idx ON pos_sales (bot_id);

CREATE TABLE IF NOT EXISTS pos_cash_movements (
  id TEXT PRIMARY KEY,
  register_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pos_cash_movements_bot_idx ON pos_cash_movements (bot_id);

CREATE TABLE IF NOT EXISTS pos_shipments (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  sale_id TEXT,
  online_request_id TEXT,
  customer_id TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  address TEXT,
  tracking_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',
  eta TEXT,
  notes TEXT,
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  preparing_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sucursal_id TEXT
);
CREATE INDEX IF NOT EXISTS pos_shipments_bot_idx ON pos_shipments (bot_id);

CREATE TABLE IF NOT EXISTS pos_devices (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  sucursal_id TEXT,
  device_name TEXT NOT NULL,
  serial TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  app_version TEXT,
  platform TEXT,
  registered_by TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pos_devices_bot_idx ON pos_devices (bot_id);

CREATE TABLE IF NOT EXISTS pos_deletions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS pos_deletions_bot_idx ON pos_deletions (bot_id);

-- ---------- Accesos: de esto depende toda la seguridad ----------
--
-- Reemplaza a las 360 políticas de Supabase. La capa de acceso lee esta
-- tabla para saber qué tiendas puede tocar cada persona, y filtra por ahí.
-- Si esta tabla queda vacía para alguien, no ve NADA. Falla cerrando.
CREATE TABLE IF NOT EXISTS _acceso (
  user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'dueno',   -- dueno | socio | vendedor
  puede_editar INTEGER NOT NULL DEFAULT 1,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, bot_id)
);
CREATE INDEX IF NOT EXISTS _acceso_user_idx ON _acceso (user_id);

-- ---------- Interno del servicio ----------
CREATE TABLE IF NOT EXISTS _salud (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO _salud (id) VALUES (1);

-- Ajustes internos (la llave de la mudanza de imágenes). Se escribe desde el
-- panel con el token del sitio, nunca desde el código: por eso el repositorio
-- puede ser público sin exponer nada.
CREATE TABLE IF NOT EXISTS _config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

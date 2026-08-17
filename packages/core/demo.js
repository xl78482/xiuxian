import { nowIso, one, run } from './database.js';

function ensureCategory(db, id, name, slug, position) {
  const now = nowIso();
  run(
    db,
    `INSERT OR IGNORE INTO categories (id, name, slug, position, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    id,
    name,
    slug,
    position,
    now,
    now,
  );
}

function ensureProduct(db, product, variants) {
  const now = nowIso();
  run(
    db,
    `INSERT OR IGNORE INTO products
     (id, category_id, title, slug, description, instructions, image_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    product.id,
    product.categoryId,
    product.title,
    product.slug,
    product.description,
    product.instructions,
    product.imageUrl,
    now,
    now,
  );
  for (const variant of variants) {
    run(
      db,
      `INSERT OR IGNORE INTO product_variants
       (id, product_id, name, sku, price_fen, max_per_order, position, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      variant.id,
      product.id,
      variant.name,
      variant.sku,
      variant.priceFen,
      variant.maxPerOrder,
      variant.position,
      now,
      now,
    );
  }
}

function seedCards(commerce, db, actor, variantId, prefix, count) {
  const total = Number(one(db, 'SELECT COUNT(*) AS total FROM card_credentials WHERE variant_id = ?', variantId).total);
  if (total > 0) return;
  const cards = Array.from({ length: count }, (_, index) => ({
    code: `${prefix}-${String(index + 1).padStart(4, '0')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    password: index % 3 === 0 ? `P${String(index + 1).padStart(4, '0')}` : '',
    note: '演示环境卡密',
  }));
  commerce.importCards(actor, { variantId, batchLabel: `演示批次 ${prefix}`, cards });
}

export function seedDemoData(runtime) {
  const { db, commerce, config } = runtime;
  const adminTelegramId = [...config.adminTelegramIds][0] ?? '100000001';
  config.adminTelegramIds.add(String(adminTelegramId));
  const admin = commerce.upsertTelegramUser({
    id: Number(adminTelegramId),
    first_name: 'XiuXian Admin',
    username: 'xiuxian_admin',
  });

  ensureCategory(db, 'cat-membership', '会员订阅', 'membership', 10);
  ensureCategory(db, 'cat-recharge', '数字点卡', 'recharge', 20);
  ensureCategory(db, 'cat-code', '兑换代码', 'redeem-code', 30);

  ensureProduct(db, {
    id: 'prd-stream-pass', categoryId: 'cat-membership', title: 'Stream Pass', slug: 'stream-pass',
    description: '高清内容订阅兑换码。', instructions: '兑换后按平台提示完成绑定。', imageUrl: '/assets/stream-pass.png',
  }, [
    { id: 'sku-stream-1m', name: '月度会员', sku: 'STREAM-1M', priceFen: 1990, maxPerOrder: 3, position: 10 },
    { id: 'sku-stream-3m', name: '季度会员', sku: 'STREAM-3M', priceFen: 4990, maxPerOrder: 2, position: 20 },
  ]);
  ensureProduct(db, {
    id: 'prd-game-points', categoryId: 'cat-recharge', title: 'Game Points', slug: 'game-points',
    description: '游戏点数兑换卡。', instructions: '在游戏内兑换中心输入卡密。', imageUrl: '/assets/game-points.png',
  }, [
    { id: 'sku-game-100', name: '100 点', sku: 'GAME-100', priceFen: 1000, maxPerOrder: 5, position: 10 },
    { id: 'sku-game-500', name: '500 点', sku: 'GAME-500', priceFen: 4500, maxPerOrder: 3, position: 20 },
  ]);
  ensureProduct(db, {
    id: 'prd-gift-vault', categoryId: 'cat-code', title: 'Gift Vault', slug: 'gift-vault',
    description: '礼品兑换代码。', instructions: '兑换码仅限一次使用，请妥善保存。', imageUrl: '/assets/gift-vault.png',
  }, [
    { id: 'sku-gift-50', name: '50 元面额', sku: 'GIFT-50', priceFen: 5000, maxPerOrder: 2, position: 10 },
  ]);

  seedCards(commerce, db, admin, 'sku-stream-1m', 'STREAM1M', 30);
  seedCards(commerce, db, admin, 'sku-stream-3m', 'STREAM3M', 20);
  seedCards(commerce, db, admin, 'sku-game-100', 'GAME100', 50);
  seedCards(commerce, db, admin, 'sku-game-500', 'GAME500', 30);
  seedCards(commerce, db, admin, 'sku-gift-50', 'GIFT50', 25);
  return admin;
}

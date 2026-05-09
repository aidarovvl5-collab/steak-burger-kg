const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const STORE_PATH = path.join(ROOT, "data", "store.json");
const TOKEN_SECRET = "steak-burger-local-admin-token";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const roles = new Set(["manager", "operator"]);
const statuses = new Set(["new", "accepted", "cooking", "delivery", "done", "cancelled"]);

function now() {
  return new Date().toISOString();
}

function makeId(prefix = "") {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function readStore() {
  const raw = await fs.readFile(STORE_PATH, "utf8");
  return normalizeStore(JSON.parse(raw));
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, "utf8");
}

function normalizeStore(store) {
  store.business ||= {
    name: "STEAK BURGER",
    city: "Бишкек",
    phone: "0559310520",
    address: "Шералиева 186/2",
    hours: "24/7",
    deliveryFee: 150,
    freeDeliveryFrom: 1800
  };
  store.deliveryZones ||= [
    {
      id: "center",
      name: "Центр",
      keywords: ["центр", "киевская", "токтогула", "цум", "манаса", "советская"],
      deliveryFee: 100,
      freeDeliveryFrom: 1500,
      eta: "25-35 минут",
      comment: "Быстрая зона рядом с центром",
      active: true,
      isDefault: false,
      createdAt: now()
    },
    {
      id: "bishkek-default",
      name: "Бишкек стандарт",
      keywords: ["бишкек"],
      deliveryFee: 150,
      freeDeliveryFrom: 1800,
      eta: "30-45 минут",
      comment: "Зона по умолчанию",
      active: true,
      isDefault: true,
      createdAt: now()
    }
  ];
  store.menu ||= [];
  store.orders ||= [];
  store.promos ||= [{
    code: "BURGER10",
    type: "percent",
    value: 10,
    minSubtotal: 0,
    active: true,
    uses: 0,
    createdAt: now()
  }];
  store.clients ||= [];

  if (!store.users) {
    const admin = store.admin || {};
    store.users = [{
      id: "u-manager",
      username: admin.username || "Мухаммед",
      role: "manager",
      active: true,
      salt: admin.salt || "steak-burger-bishkek-admin",
      passwordHash: admin.passwordHash || hashPassword("310520", "steak-burger-bishkek-admin"),
      createdAt: now()
    }];
  }

  store.menu = store.menu.map((item) => ({
    active: true,
    ...item,
    tags: Array.isArray(item.tags) ? item.tags : normalizeTags(item.tags)
  }));

  store.promos = store.promos.map((promo) => normalizePromo(promo, promo));
  store.deliveryZones = store.deliveryZones.map((zone) => normalizeDeliveryZone(zone, zone));
  store.users = store.users.map((user) => ({ active: true, ...user }));

  return store;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, passwordHash: hashPassword(password, salt) };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function signToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    username: user.username,
    role: user.role,
    expiresAt: Date.now() + 1000 * 60 * 60 * 12
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function readToken(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature] = token.split(".");

  if (!payload || !signature) return null;

  const expected = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(payload)
    .digest("base64url");

  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.expiresAt > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function getCurrentUser(req, store) {
  const token = readToken(req);
  if (!token) return null;
  const user = store.users.find((item) => item.id === token.id && item.active !== false);
  return user || null;
}

function requireUser(req, res, store, allowedRoles = ["manager", "operator"]) {
  const user = getCurrentUser(req, store);
  if (!user) {
    sendJson(res, 401, { error: "Нужен вход в админку." });
    return null;
  }
  if (!allowedRoles.includes(user.role)) {
    sendJson(res, 403, { error: "Недостаточно прав." });
    return null;
  }
  return user;
}

function normalizeStatus(status) {
  return statuses.has(status) ? status : "new";
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).map((tag) => tag.trim()).filter(Boolean);
  return String(tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `item-${Date.now().toString(36)}`;
}

function normalizeMenuItem(body, existing = {}) {
  const name = String(body.name ?? existing.name ?? "").trim();
  const category = String(body.category ?? existing.category ?? "burgers").trim();
  const price = Math.max(0, Number(body.price ?? existing.price ?? 0));

  if (!name) {
    const error = new Error("Укажите название блюда.");
    error.status = 400;
    throw error;
  }
  if (!price) {
    const error = new Error("Укажите цену блюда.");
    error.status = 400;
    throw error;
  }

  return {
    id: existing.id || slugify(body.id || name),
    name,
    category,
    price,
    weight: String(body.weight ?? existing.weight ?? "").trim(),
    desc: String(body.desc ?? existing.desc ?? "").trim(),
    tags: normalizeTags(body.tags ?? existing.tags),
    image: String(body.image ?? existing.image ?? "").trim(),
    active: body.active === undefined ? existing.active !== false : Boolean(body.active),
    createdAt: existing.createdAt || now(),
    updatedAt: now()
  };
}

function normalizePromo(body, existing = {}) {
  const code = String(body.code ?? existing.code ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
  const type = body.type === "fixed" ? "fixed" : "percent";
  const value = Math.max(0, Number(body.value ?? existing.value ?? 0));
  const minSubtotal = Math.max(0, Number(body.minSubtotal ?? existing.minSubtotal ?? 0));

  return {
    code,
    type,
    value,
    minSubtotal,
    active: body.active === undefined ? existing.active !== false : Boolean(body.active),
    uses: Number(existing.uses || 0),
    createdAt: existing.createdAt || now(),
    updatedAt: now()
  };
}

function normalizeDeliveryZone(body, existing = {}) {
  const name = String(body.name ?? existing.name ?? "").trim();
  const id = existing.id || slugify(body.id || name);
  const keywords = normalizeTags(body.keywords ?? existing.keywords);

  if (!name) {
    const error = new Error("Укажите название зоны.");
    error.status = 400;
    throw error;
  }

  return {
    id,
    name,
    keywords,
    deliveryFee: Math.max(0, Number(body.deliveryFee ?? existing.deliveryFee ?? 0)),
    freeDeliveryFrom: Math.max(0, Number(body.freeDeliveryFrom ?? existing.freeDeliveryFrom ?? 0)),
    eta: String(body.eta ?? existing.eta ?? "").trim(),
    comment: String(body.comment ?? existing.comment ?? "").trim(),
    active: body.active === undefined ? existing.active !== false : Boolean(body.active),
    isDefault: body.isDefault === undefined ? Boolean(existing.isDefault) : Boolean(body.isDefault),
    createdAt: existing.createdAt || now(),
    updatedAt: now()
  };
}

function resolveDeliveryZone(store, address) {
  const activeZones = (store.deliveryZones || []).filter((zone) => zone.active !== false);
  const normalizedAddress = String(address || "").toLowerCase();
  const directMatch = activeZones.find((zone) => {
    if (zone.isDefault) return false;
    return (zone.keywords || []).some((keyword) => normalizedAddress.includes(String(keyword).toLowerCase()));
  });

  return directMatch || activeZones.find((zone) => zone.isDefault) || activeZones[0] || null;
}

function buildDeliveryQuote(store, address, subtotal, deliveryType = "delivery") {
  if (deliveryType === "pickup") {
    return { zone: null, delivery: 0, freeDeliveryFrom: 0, eta: "Самовывоз" };
  }

  const zone = resolveDeliveryZone(store, address);
  const deliveryFee = zone ? Number(zone.deliveryFee || 0) : Number(store.business.deliveryFee || 0);
  const freeDeliveryFrom = zone ? Number(zone.freeDeliveryFrom || 0) : Number(store.business.freeDeliveryFrom || 0);
  const delivery = subtotal > 0 && subtotal < freeDeliveryFrom ? deliveryFee : 0;

  return {
    zone,
    delivery,
    freeDeliveryFrom,
    eta: zone?.eta || "Уточнит администратор"
  };
}

function calculateDiscount(subtotal, promo) {
  if (!promo || promo.active === false || subtotal < Number(promo.minSubtotal || 0)) return 0;
  if (promo.type === "fixed") return Math.min(subtotal, Math.round(Number(promo.value || 0)));
  return Math.min(subtotal, Math.round(subtotal * Number(promo.value || 0) / 100));
}

function findPromo(store, code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;
  return store.promos.find((promo) => promo.code === normalized) || null;
}

function upsertClient(store, order) {
  const phone = order.customer.phone;
  if (!phone) return;

  let client = store.clients.find((item) => item.phone === phone);
  if (!client) {
    client = {
      id: makeId("C"),
      name: order.customer.name,
      phone,
      address: order.customer.address,
      notes: "",
      tags: [],
      ordersCount: 0,
      totalSpent: 0,
      lastOrderAt: order.createdAt,
      createdAt: order.createdAt
    };
    store.clients.push(client);
  }

  client.name = order.customer.name || client.name;
  client.address = order.customer.address || client.address;
  client.ordersCount = Number(client.ordersCount || 0) + 1;
  client.totalSpent = Number(client.totalSpent || 0) + order.total;
  client.lastOrderAt = order.createdAt;
  client.updatedAt = now();
}

function rebuildClients(store) {
  const existing = new Map((store.clients || []).map((client) => [client.phone, client]));
  const clients = new Map();

  [...store.orders].reverse().forEach((order) => {
    const phone = order.customer.phone;
    if (!phone) return;

    const previous = existing.get(phone) || {};
    const client = clients.get(phone) || {
      id: previous.id || makeId("C"),
      name: order.customer.name,
      phone,
      address: order.customer.address,
      notes: previous.notes || "",
      tags: previous.tags || [],
      ordersCount: 0,
      totalSpent: 0,
      lastOrderAt: order.createdAt,
      createdAt: previous.createdAt || order.createdAt
    };

    client.name = order.customer.name || client.name;
    client.address = order.customer.address || client.address;
    client.ordersCount += 1;
    client.totalSpent += order.total;
    client.lastOrderAt = order.createdAt;
    clients.set(phone, client);
  });

  return [...clients.values()].sort((a, b) => new Date(b.lastOrderAt) - new Date(a.lastOrderAt));
}

function buildOrder(store, body) {
  const customer = body.customer || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const menuById = new Map(store.menu.filter((item) => item.active !== false).map((item) => [item.id, item]));
  const orderItems = items
    .map((item) => {
      const menuItem = menuById.get(item.id);
      const quantity = Math.max(1, Number(item.quantity || item.qty || 1));
      if (!menuItem) return null;
      return {
        id: menuItem.id,
        name: menuItem.name,
        price: menuItem.price,
        quantity,
        total: menuItem.price * quantity
      };
    })
    .filter(Boolean);

  if (!orderItems.length) {
    const error = new Error("Добавьте хотя бы одно блюдо.");
    error.status = 400;
    throw error;
  }

  if (!customer.name || !customer.phone) {
    const error = new Error("Укажите имя и телефон.");
    error.status = 400;
    throw error;
  }

  const deliveryType = body.deliveryType === "pickup" ? "pickup" : "delivery";
  if (deliveryType === "delivery" && !customer.address) {
    const error = new Error("Укажите адрес доставки.");
    error.status = 400;
    throw error;
  }

  const subtotal = orderItems.reduce((sum, item) => sum + item.total, 0);
  const promo = findPromo(store, body.promoCode);
  const discount = calculateDiscount(subtotal, promo);
  const deliveryQuote = buildDeliveryQuote(store, customer.address, subtotal, deliveryType);
  const delivery = deliveryQuote.delivery;
  const total = Math.max(0, subtotal - discount + delivery);

  if (promo && discount > 0) promo.uses = Number(promo.uses || 0) + 1;

  return {
    id: makeId("O"),
    createdAt: now(),
    status: "new",
    customer: {
      name: String(customer.name).trim(),
      phone: String(customer.phone).trim(),
      address: String(customer.address || "").trim(),
      comment: String(customer.comment || "").trim()
    },
    deliveryType,
    deliveryZone: deliveryQuote.zone ? {
      id: deliveryQuote.zone.id,
      name: deliveryQuote.zone.name,
      eta: deliveryQuote.zone.eta,
      comment: deliveryQuote.zone.comment
    } : null,
    deliveryTime: String(body.deliveryTime || "Как можно скорее"),
    peopleCount: String(body.peopleCount || "1 персона"),
    payment: String(body.payment || "elqr"),
    promoCode: discount > 0 && promo ? promo.code : "",
    items: orderItems,
    subtotal,
    discount,
    delivery,
    total
  };
}

async function handleApi(req, res, url) {
  const store = await readStore();

  if (req.method === "GET" && url.pathname === "/api/business") {
    sendJson(res, 200, store.business);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/menu") {
    sendJson(res, 200, store.menu.filter((item) => item.active !== false));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/delivery-zones") {
    sendJson(res, 200, store.deliveryZones.filter((zone) => zone.active !== false));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/delivery-zones/resolve") {
    const body = await parseBody(req);
    const subtotal = Math.max(0, Number(body.subtotal || 0));
    const quote = buildDeliveryQuote(store, body.address, subtotal, body.deliveryType || "delivery");
    sendJson(res, 200, quote);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/promos/validate") {
    const body = await parseBody(req);
    const subtotal = Math.max(0, Number(body.subtotal || 0));
    const promo = findPromo(store, body.code);
    const discount = calculateDiscount(subtotal, promo);

    if (!promo || promo.active === false) {
      sendJson(res, 404, { valid: false, error: "Промокод не найден." });
      return true;
    }
    if (subtotal < Number(promo.minSubtotal || 0)) {
      sendJson(res, 400, { valid: false, error: `Промокод действует от ${promo.minSubtotal} сом.` });
      return true;
    }

    sendJson(res, 200, { valid: discount > 0, discount, promo });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await parseBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const user = store.users.find((item) => item.username === username && item.active !== false);

    if (user && hashPassword(password, user.salt) === user.passwordHash) {
      sendJson(res, 200, { token: signToken(user), user: publicUser(user) });
    } else {
      sendJson(res, 401, { error: "Неверный логин или пароль." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = requireUser(req, res, store);
    if (!user) return true;
    sendJson(res, 200, { user: publicUser(user) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders") {
    const body = await parseBody(req);
    const order = buildOrder(store, body);
    store.orders.unshift(order);
    upsertClient(store, order);
    await writeStore(store);
    sendJson(res, 201, { order });
    return true;
  }

  if (url.pathname === "/api/orders") {
    if (!requireUser(req, res, store)) return true;

    if (req.method === "GET") {
      sendJson(res, 200, store.orders);
      return true;
    }
  }

  const statusMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/status$/);
  if (statusMatch) {
    if (!requireUser(req, res, store)) return true;

    if (req.method === "PATCH") {
      const body = await parseBody(req);
      const order = store.orders.find((item) => item.id === statusMatch[1]);
      if (!order) {
        sendJson(res, 404, { error: "Заказ не найден." });
        return true;
      }

      order.status = normalizeStatus(body.status);
      order.updatedAt = now();
      await writeStore(store);
      sendJson(res, 200, { order });
      return true;
    }
  }

  if (url.pathname === "/api/users") {
    const currentUser = requireUser(req, res, store, ["manager"]);
    if (!currentUser) return true;

    if (req.method === "GET") {
      sendJson(res, 200, store.users.map(publicUser));
      return true;
    }

    if (req.method === "POST") {
      const body = await parseBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const role = roles.has(body.role) ? body.role : "operator";

      if (!username || !password) {
        sendJson(res, 400, { error: "Укажите логин и пароль." });
        return true;
      }
      if (store.users.some((user) => user.username === username)) {
        sendJson(res, 409, { error: "Такой логин уже есть." });
        return true;
      }

      const passwordRecord = createPasswordRecord(password);
      const user = {
        id: makeId("U"),
        username,
        role,
        active: true,
        ...passwordRecord,
        createdAt: now()
      };
      store.users.push(user);
      await writeStore(store);
      sendJson(res, 201, { user: publicUser(user) });
      return true;
    }
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    const currentUser = requireUser(req, res, store, ["manager"]);
    if (!currentUser) return true;

    const user = store.users.find((item) => item.id === userMatch[1]);
    if (!user) {
      sendJson(res, 404, { error: "Пользователь не найден." });
      return true;
    }

    if (req.method === "PATCH") {
      const body = await parseBody(req);
      if (body.username !== undefined) user.username = String(body.username).trim() || user.username;
      if (body.role !== undefined && roles.has(body.role)) user.role = body.role;
      if (body.active !== undefined && user.id !== currentUser.id) user.active = Boolean(body.active);
      if (body.password) Object.assign(user, createPasswordRecord(body.password));
      user.updatedAt = now();
      await writeStore(store);
      sendJson(res, 200, { user: publicUser(user) });
      return true;
    }

    if (req.method === "DELETE") {
      if (user.id === currentUser.id) {
        sendJson(res, 400, { error: "Нельзя отключить самого себя." });
        return true;
      }
      user.active = false;
      user.updatedAt = now();
      await writeStore(store);
      sendJson(res, 200, { user: publicUser(user) });
      return true;
    }
  }

  if (url.pathname === "/api/admin/menu") {
    if (!requireUser(req, res, store, ["manager"])) return true;

    if (req.method === "GET") {
      sendJson(res, 200, store.menu);
      return true;
    }
  }

  if (url.pathname === "/api/menu") {
    if (!requireUser(req, res, store, ["manager"])) return true;

    if (req.method === "POST") {
      const body = await parseBody(req);
      const item = normalizeMenuItem(body);
      if (store.menu.some((menuItem) => menuItem.id === item.id)) {
        sendJson(res, 409, { error: "Такой ID блюда уже есть." });
        return true;
      }
      store.menu.push(item);
      await writeStore(store);
      sendJson(res, 201, { item });
      return true;
    }
  }

  const menuMatch = url.pathname.match(/^\/api\/menu\/([^/]+)$/);
  if (menuMatch) {
    if (!requireUser(req, res, store, ["manager"])) return true;

    const item = store.menu.find((menuItem) => menuItem.id === menuMatch[1]);
    if (!item) {
      sendJson(res, 404, { error: "Блюдо не найдено." });
      return true;
    }

    if (req.method === "PATCH") {
      const body = await parseBody(req);
      Object.assign(item, normalizeMenuItem(body, item));
      await writeStore(store);
      sendJson(res, 200, { item });
      return true;
    }

    if (req.method === "DELETE") {
      item.active = false;
      item.updatedAt = now();
      await writeStore(store);
      sendJson(res, 200, { item });
      return true;
    }
  }

  if (url.pathname === "/api/promos") {
    if (!requireUser(req, res, store, ["manager"])) return true;

    if (req.method === "GET") {
      sendJson(res, 200, store.promos);
      return true;
    }

    if (req.method === "POST") {
      const body = await parseBody(req);
      const promo = normalizePromo(body);
      if (!promo.code || !promo.value) {
        sendJson(res, 400, { error: "Укажите код и размер скидки." });
        return true;
      }
      if (store.promos.some((item) => item.code === promo.code)) {
        sendJson(res, 409, { error: "Такой промокод уже есть." });
        return true;
      }
      store.promos.push(promo);
      await writeStore(store);
      sendJson(res, 201, { promo });
      return true;
    }
  }

  if (url.pathname === "/api/admin/delivery-zones") {
    if (!requireUser(req, res, store, ["manager"])) return true;

    if (req.method === "GET") {
      sendJson(res, 200, store.deliveryZones);
      return true;
    }

    if (req.method === "POST") {
      const zone = normalizeDeliveryZone(await parseBody(req));
      if (store.deliveryZones.some((item) => item.id === zone.id)) {
        sendJson(res, 409, { error: "Такая зона уже есть." });
        return true;
      }
      if (zone.isDefault) store.deliveryZones.forEach((item) => { item.isDefault = false; });
      store.deliveryZones.push(zone);
      await writeStore(store);
      sendJson(res, 201, { zone });
      return true;
    }
  }

  const deliveryZoneMatch = url.pathname.match(/^\/api\/admin\/delivery-zones\/([^/]+)$/);
  if (deliveryZoneMatch) {
    if (!requireUser(req, res, store, ["manager"])) return true;

    const zone = store.deliveryZones.find((item) => item.id === deliveryZoneMatch[1]);
    if (!zone) {
      sendJson(res, 404, { error: "Зона не найдена." });
      return true;
    }

    if (req.method === "PATCH") {
      Object.assign(zone, normalizeDeliveryZone(await parseBody(req), zone));
      if (zone.isDefault) {
        store.deliveryZones.forEach((item) => {
          if (item.id !== zone.id) item.isDefault = false;
        });
      }
      await writeStore(store);
      sendJson(res, 200, { zone });
      return true;
    }

    if (req.method === "DELETE") {
      zone.active = false;
      zone.updatedAt = now();
      await writeStore(store);
      sendJson(res, 200, { zone });
      return true;
    }
  }

  const promoMatch = url.pathname.match(/^\/api\/promos\/([^/]+)$/);
  if (promoMatch) {
    if (!requireUser(req, res, store, ["manager"])) return true;

    const promo = store.promos.find((item) => item.code === promoMatch[1].toUpperCase());
    if (!promo) {
      sendJson(res, 404, { error: "Промокод не найден." });
      return true;
    }

    if (req.method === "PATCH") {
      Object.assign(promo, normalizePromo(await parseBody(req), promo));
      await writeStore(store);
      sendJson(res, 200, { promo });
      return true;
    }

    if (req.method === "DELETE") {
      promo.active = false;
      promo.updatedAt = now();
      await writeStore(store);
      sendJson(res, 200, { promo });
      return true;
    }
  }

  if (url.pathname === "/api/clients") {
    if (!requireUser(req, res, store, ["manager"])) return true;

    if (req.method === "GET") {
      sendJson(res, 200, rebuildClients(store));
      return true;
    }
  }

  const clientMatch = url.pathname.match(/^\/api\/clients\/(.+)$/);
  if (clientMatch) {
    if (!requireUser(req, res, store, ["manager"])) return true;

    const phone = decodeURIComponent(clientMatch[1]);
    let client = store.clients.find((item) => item.phone === phone);
    if (!client) {
      client = rebuildClients(store).find((item) => item.phone === phone);
      if (client) store.clients.push(client);
    }
    if (!client) {
      sendJson(res, 404, { error: "Клиент не найден." });
      return true;
    }

    if (req.method === "PATCH") {
      const body = await parseBody(req);
      if (body.notes !== undefined) client.notes = String(body.notes || "");
      if (body.tags !== undefined) client.tags = normalizeTags(body.tags);
      client.updatedAt = now();
      await writeStore(store);
      sendJson(res, 200, { client });
      return true;
    }
  }

  return false;
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = cleanPath === "/admin" || cleanPath === "/admin/"
    ? path.join(ROOT, "admin", "index.html")
    : path.join(ROOT, cleanPath);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(resolved);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(resolved)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { error: "API route not found." });
      return;
    }

    await serveStatic(res, decodeURIComponent(url.pathname));
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  const localHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`STEAK BURGER server: http://${localHost}:${PORT}/`);
  console.log(`Admin panel: http://${localHost}:${PORT}/admin`);
});

module.exports = server;

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function decodeXml(value) {
  return text(value)
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlTag(block, names) {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
    if (match) return decodeXml(match[1]);
  }
  return "";
}

function xmlAttribute(block, tag, attribute) {
  const match = new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, "i").exec(block);
  return match ? decodeXml(match[1]) : "";
}

function parseFeed(xml, source) {
  const blocks = String(xml || "").match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  return blocks.slice(0, 50).map((block, index) => {
    const title = xmlTag(block, ["title"]);
    const link = xmlTag(block, ["link"]) || xmlAttribute(block, "link", "href");
    const published = xmlTag(block, ["pubDate", "published", "updated", "dc:date"]);
    const summary = xmlTag(block, ["description", "summary", "content", "content:encoded"]);
    const id = xmlTag(block, ["guid", "id"]) || link || `${title}:${published}`;
    const image = xmlAttribute(block, "media:thumbnail", "url")
      || xmlAttribute(block, "media:content", "url")
      || xmlAttribute(block, "enclosure", "url");
    return {
      id,
      type: "post",
      title: title || "Feed 更新",
      summary,
      link: link || source,
      image,
      author: xmlTag(block, ["author", "dc:creator"]),
      publishedAt: Number.isFinite(Date.parse(published)) ? Date.parse(published) : 0,
      order: index,
    };
  }).filter((item) => item.id);
}

function bilibiliUid(source) {
  const value = text(source);
  const match = /(?:space\.bilibili\.com\/)?(\d{1,20})/.exec(value);
  if (!match) throw new Error("Bilibili 来源必须是 UP 主 UID 或空间链接");
  return match[1];
}

function bilibiliDynamicItem(item) {
  const author = item?.modules?.module_author || {};
  const dynamic = item?.modules?.module_dynamic || {};
  const major = dynamic.major || {};
  const archive = major.archive || {};
  const opus = major.opus || {};
  const draw = major.draw || {};
  const isVideo = item?.type === "DYNAMIC_TYPE_AV" || !!archive.bvid;
  const summary = text(dynamic.desc?.text || opus.summary?.text || opus.summary || archive.desc);
  const title = text(archive.title || opus.title || summary.slice(0, 80) || (isVideo ? "发布了新视频" : "发布了新动态"));
  const jump = text(archive.jump_url || opus.jump_url || item?.jump_url);
  const link = jump.startsWith("//") ? `https:${jump}` : (jump || `https://t.bilibili.com/${item?.id_str || item?.id}`);
  const image = text(archive.cover || opus.pics?.[0]?.url || draw.items?.[0]?.src);
  return {
    id: text(item?.id_str || item?.id),
    type: isVideo ? "video" : "post",
    title,
    summary,
    link,
    image,
    author: text(author.name),
    publishedAt: Number(author.pub_ts || 0) * 1000,
  };
}

async function fetchBilibili(api, subscription) {
  const uid = bilibiliUid(subscription.source);
  const wantsContent = subscription.events.some((event) => event === "post" || event === "video");
  let items = [];
  if (wantsContent) {
    const cookie = await api.getSecret("bilibiliCookie");
    if (!cookie) throw new Error("监控 Bilibili 动态或视频需要先配置登录 Cookie");
    const endpoint = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(uid)}&features=itemOpusStyle`;
    const payload = await api.fetchJson(endpoint, { headers: { referer: `https://space.bilibili.com/${uid}/dynamic`, cookie } });
    if (payload?.code !== 0) throw new Error(`Bilibili 动态接口错误：${payload?.message || payload?.code || "unknown"}`);
    items = Array.isArray(payload?.data?.items)
      ? payload.data.items.map(bilibiliDynamicItem).filter((item) => item.id)
      : [];
  }
  let live = null;
  if (subscription.events.some((event) => event === "liveStart" || event === "liveEnd")) {
    const livePayload = await api.fetchJson("https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids", {
      method: "POST",
      body: { uids: [Number(uid)] },
      headers: { referer: `https://space.bilibili.com/${uid}` },
    });
    if (livePayload?.code !== 0) throw new Error(`Bilibili 直播接口错误：${livePayload?.message || livePayload?.code || "unknown"}`);
    const row = livePayload?.data?.[uid] || livePayload?.data?.[Number(uid)] || null;
    if (row) live = {
      status: Number(row.live_status) === 1 ? "live" : "offline",
      title: text(row.title || "直播"),
      author: text(row.uname),
      image: text(row.cover_from_user || row.keyframe || row.face),
      link: `https://live.bilibili.com/${row.room_id || row.short_id || ""}`,
    };
  }
  return { items, live };
}

async function fetchRss(api, subscription) {
  const source = text(subscription.source);
  if (!/^https?:\/\//i.test(source)) throw new Error("RSS 来源必须是 HTTP 或 HTTPS Feed 地址");
  return { items: parseFeed(await api.fetchText(source, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } }), source), live: null };
}

function normalizeSubscription(value, index) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const provider = item.provider === "rss" ? "rss" : "bilibili";
  const events = list(item.events).filter((event) => ["post", "video", "liveStart", "liveEnd"].includes(event));
  return {
    id: text(item.id) || `monitor-${index + 1}`,
    name: text(item.name) || (provider === "rss" ? "RSS 订阅" : "Bilibili 订阅"),
    enabled: item.enabled !== false,
    provider,
    source: text(item.source),
    events: events.length ? events : (provider === "rss" ? ["post"] : ["post", "video", "liveStart"]),
    targetChatIds: list(item.targetChatIds).filter((chatId) => /^onebot:(?:group|private):\d+$/.test(chatId)),
    include: list(item.include),
    exclude: list(item.exclude),
    template: text(item.template),
  };
}

function matchesFilter(item, subscription) {
  const haystack = `${item.title} ${item.summary} ${item.author}`.toLowerCase();
  if (subscription.exclude.some((word) => haystack.includes(word.toLowerCase()))) return false;
  return !subscription.include.length || subscription.include.some((word) => haystack.includes(word.toLowerCase()));
}

function renderEvent(subscription, item, eventType) {
  const labels = { post: "发布了新动态", video: "发布了新视频", liveStart: "开播了", liveEnd: "下播了" };
  const defaultText = [
    `${item.author || subscription.name} ${labels[eventType]}`,
    item.title,
    item.summary && item.summary !== item.title ? item.summary.slice(0, 300) : "",
    item.link,
  ].filter(Boolean).join("\n");
  if (!subscription.template) return defaultText;
  return subscription.template
    .replaceAll("{author}", item.author || subscription.name)
    .replaceAll("{event}", labels[eventType])
    .replaceAll("{title}", item.title || "")
    .replaceAll("{summary}", item.summary || "")
    .replaceAll("{link}", item.link || "");
}

function throwIfCanceled(ctx) {
  if (ctx.signal?.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("内容监控已取消");
}

function hasBudget(ctx, reserveMs) {
  throwIfCanceled(ctx);
  return !Number.isFinite(ctx.deadlineAt) || Date.now() + reserveMs + 5000 < ctx.deadlineAt;
}

function deliveryKey(item, eventType) {
  return `${eventType}:${text(item.id || item.status || item.link).slice(0, 256)}`;
}

function pendingDeliveries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(-100).filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.item));
}

async function pushEvent(ctx, subscription, delivery, commit) {
  const blocks = [{ type: "text", text: renderEvent(subscription, delivery.item, delivery.eventType) }];
  if (delivery.item.image) blocks.push({ type: "image", url: delivery.item.image });
  const delivered = new Set(list(delivery.deliveredChatIds));
  for (const chatId of [...new Set(subscription.targetChatIds)]) {
    if (delivered.has(chatId)) continue;
    if (!hasBudget(ctx, 30000)) return false;
    const result = await ctx.api.push(chatId, blocks);
    if (result?.networkStatus === "error") throw new Error(`推送到 ${chatId} 失败：${result.note || "unknown"}`);
    delivered.add(chatId);
    delivery.deliveredChatIds = [...delivered];
    await commit();
  }
  return true;
}

async function poll(ctx, options = {}) {
  const config = ctx.config || {};
  const subscriptions = (Array.isArray(config.subscriptions) ? config.subscriptions : [])
    .slice(0, 100)
    .map(normalizeSubscription)
    .filter((item) => item.enabled && item.source && item.targetChatIds.length);
  const saved = await ctx.api.getState("cursors", "channel");
  const cursors = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  subscriptions.sort((a, b) => {
    const aCursor = cursors[a.id] || {};
    const bCursor = cursors[b.id] || {};
    const pendingOrder = Number(!Object.keys(pendingDeliveries(aCursor.pendingDeliveries)).length)
      - Number(!Object.keys(pendingDeliveries(bCursor.pendingDeliveries)).length);
    return pendingOrder || Number(aCursor.lastCheckedAt || 0) - Number(bCursor.lastCheckedAt || 0);
  });
  const summaries = [];
  let checked = 0;
  let fetchedCount = 0;
  let pushed = 0;
  let budgetReached = false;
  const requestIntervalMs = integer(config.requestIntervalMs, 800, 0, 30000);

  for (const subscription of subscriptions) {
    throwIfCanceled(ctx);
    const previous = cursors[subscription.id] && typeof cursors[subscription.id] === "object" ? cursors[subscription.id] : {};
    if (!options.force && Number(previous.nextRetryAt || 0) > Date.now()) continue;
    let cursor = { ...previous, pendingDeliveries: pendingDeliveries(previous.pendingDeliveries) };
    const commit = async () => {
      cursors[subscription.id] = cursor;
      await ctx.api.setState("cursors", cursors, "channel");
    };
    checked += 1;
    try {
      for (const [key, delivery] of Object.entries(cursor.pendingDeliveries)) {
        if (!await pushEvent(ctx, subscription, delivery, commit)) {
          budgetReached = true;
          break;
        }
        delete cursor.pendingDeliveries[key];
        if (["post", "video"].includes(delivery.eventType) && delivery.item.id) {
          cursor.seenIds = [...new Set([delivery.item.id, ...list(cursor.seenIds)])].slice(0, 100);
        } else if (["liveStart", "liveEnd"].includes(delivery.eventType)) {
          cursor.liveStatus = delivery.item.status;
        }
        cursor.lastCheckedAt = Date.now();
        await commit();
        pushed += 1;
      }
      if (budgetReached) {
        summaries.push(`${subscription.name}：等待下轮继续推送`);
        break;
      }

      if (!hasBudget(ctx, requestIntervalMs + 30000)) {
        checked -= 1;
        budgetReached = true;
        break;
      }
      if (fetchedCount > 0 && requestIntervalMs) await ctx.api.sleep(requestIntervalMs);
      fetchedCount += 1;
      const fetched = subscription.provider === "rss"
        ? await fetchRss(ctx.api, subscription)
        : await fetchBilibili(ctx.api, subscription);
      const allItems = fetched.items;
      const items = allItems.filter((item) => matchesFilter(item, subscription));
      const itemIds = allItems.map((item) => item.id).filter(Boolean).slice(0, 100);
      const seen = new Set(list(cursor.seenIds));
      const checkedAt = Date.now();
      if (!cursor.initializedAt) {
        cursor = {
          initializedAt: checkedAt,
          seenIds: itemIds,
          lastPublishedAt: Math.max(0, ...allItems.map((item) => Number(item.publishedAt || 0))),
          liveStatus: fetched.live?.status || "unknown",
          lastCheckedAt: checkedAt,
          consecutiveFailures: 0,
          nextRetryAt: 0,
          pendingDeliveries: {},
        };
        await commit();
        summaries.push(`${subscription.name}：已建立基线`);
        continue;
      }

      const deliver = async (item, eventType) => {
        const key = deliveryKey(item, eventType);
        const delivery = cursor.pendingDeliveries[key] || { item, eventType, deliveredChatIds: [] };
        cursor.pendingDeliveries[key] = delivery;
        await commit();
        if (!await pushEvent(ctx, subscription, delivery, commit)) return false;
        delete cursor.pendingDeliveries[key];
        if (["post", "video"].includes(eventType) && item.id) {
          cursor.seenIds = [...new Set([item.id, ...list(cursor.seenIds)])].slice(0, 100);
        } else if (["liveStart", "liveEnd"].includes(eventType)) {
          cursor.liveStatus = item.status;
        }
        await commit();
        pushed += 1;
        return true;
      };
      const fresh = items.filter((item) => !seen.has(item.id) && subscription.events.includes(item.type));
      fresh.sort((a, b) => Number(a.publishedAt || 0) - Number(b.publishedAt || 0) || Number(b.order || 0) - Number(a.order || 0));
      for (const item of fresh) {
        if (!await deliver(item, item.type)) {
          budgetReached = true;
          break;
        }
      }
      if (!budgetReached && fetched.live && cursor.liveStatus !== "unknown" && fetched.live.status !== cursor.liveStatus) {
        const eventType = fetched.live.status === "live" ? "liveStart" : "liveEnd";
        if (subscription.events.includes(eventType) && !await deliver({ ...fetched.live, summary: "" }, eventType)) budgetReached = true;
      }
      if (budgetReached) {
        summaries.push(`${subscription.name}：等待下轮继续推送`);
        break;
      }
      cursor = {
        ...cursor,
        seenIds: [...new Set([...itemIds, ...list(cursor.seenIds)])].slice(0, 100),
        lastPublishedAt: Math.max(Number(cursor.lastPublishedAt || 0), ...allItems.map((item) => Number(item.publishedAt || 0))),
        liveStatus: fetched.live?.status || cursor.liveStatus || "unknown",
        lastCheckedAt: checkedAt,
        lastSuccessAt: checkedAt,
        consecutiveFailures: 0,
        nextRetryAt: 0,
      };
      await commit();
      summaries.push(`${subscription.name}：${fresh.length ? `发现 ${fresh.length} 条更新` : "无更新"}`);
    } catch (error) {
      throwIfCanceled(ctx);
      const current = cursors[subscription.id] && typeof cursors[subscription.id] === "object" ? cursors[subscription.id] : cursor;
      const failures = Number(current.consecutiveFailures || 0) + 1;
      const failedAt = Date.now();
      const base = integer(config.pollIntervalSeconds, 120, 30, 86400) * 1000;
      cursor = {
        ...current,
        lastCheckedAt: failedAt,
        lastError: error && error.message ? error.message : String(error),
        consecutiveFailures: failures,
        nextRetryAt: failedAt + Math.min(6 * 3600000, base * (2 ** Math.min(failures, 8))),
      };
      await commit();
      summaries.push(`${subscription.name}：检查失败`);
    }
  }

  await ctx.api.setState("cursors", cursors, "channel");
  return { checked, pushed, subscriptions: subscriptions.length, summaries, budgetReached };
}

async function handle(ctx) {
  if (ctx.command?.name === "monitorcheck") {
    const result = await poll(ctx, { force: true });
    return { text: `已检查 ${result.checked}/${result.subscriptions} 个订阅，推送 ${result.pushed} 条\n${result.summaries.join("\n")}`.trim() };
  }
  const config = ctx.config || {};
  const subscriptions = (Array.isArray(config.subscriptions) ? config.subscriptions : []).map(normalizeSubscription);
  const saved = await ctx.api.getState("cursors", "channel");
  const cursors = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  if (!subscriptions.length) return { text: "还没有内容监控订阅，请在桌面端机器人插件配置中添加" };
  return { text: subscriptions.map((subscription) => {
    const cursor = cursors[subscription.id] || {};
    const status = cursor.lastError ? `失败：${cursor.lastError}` : (cursor.initializedAt ? "运行中" : "等待首次检查");
    return `${subscription.enabled ? "启用" : "停用"} · ${subscription.name} · ${status}`;
  }).join("\n") };
}

module.exports = { handle, poll };

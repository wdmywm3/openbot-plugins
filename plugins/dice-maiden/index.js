const HELP = [
  "骰娘命令（/、.、! 和 。均可）",
  "",
  "【基础掷骰】",
  ".r [骰式] [原因]：通用掷骰；支持 .d50、.rd50、.rd 50、/r2d6+1 和 .r3#d20",
  "骰式：d20/3d6、+-*/^、括号、4d6k3/4d6q1、b/p 奖惩骰；可省略 d 的两侧数字",
  ".rh [骰式] [原因]：暗骰；支持 .rhd20 等紧凑格式，群聊中仅私聊发送结果",
  ".d20 [adv|dis] [+/-加值]：D20 基础、优势或劣势检定",
  "",
  "【CoC 7 版】",
  ".ra/.rc [b1|p1] [技能名] <技能值>：CoC 7 版检定",
  ".rav/.rcv [名称] <技能值> [名称] <技能值>：CoC 对抗检定",
  ".st [属性 值...]：查看或设置当前群角色卡；.st clear 清空",
  ".sc <成功损失>/<失败损失> [当前 SAN]：理智检定",
  ".en <技能名> [技能值]：技能成长检定",
  ".ti / .li：临时/总结性疯狂症状",
  ".cocchar [数量]：生成 CoC 7 版角色属性",
  "",
  "【会话设置】",
  ".set <面数|骰式|reset>：设置当前群或私聊的默认骰式；.set20 也可",
  ".dicestats：查看当前群或私聊的统计",
].join("\n");

const TEMPORARY_INSANITY = [
  "失忆：短时间忘记刚才发生的事情",
  "假性残疾：出现暂时的失明、失聪或肢体失控",
  "暴力冲动：难以控制攻击或破坏欲",
  "偏执：强烈怀疑身边的人或事物",
  "重要之人：执着于寻找或保护某个重要的人",
  "昏厥：短暂失去意识",
  "逃离：不顾一切地远离当前地点",
  "歇斯底里：情绪彻底失控",
  "恐惧症：随机产生一种强烈恐惧",
  "狂躁症：随机产生一种强迫性冲动",
];

const LONG_TERM_INSANITY = [
  "失忆：醒来后忘记一段重要经历",
  "被窃：醒来时发现重要物品遗失",
  "遍体鳞伤：在不明原因下受伤",
  "暴力倾向：留下难以解释的破坏后果",
  "极端信念：以激烈方式践行某种信念",
  "重要之人：长时间执着于接近某个人",
  "被收容：在医院或拘留场所恢复清醒",
  "远走：在陌生且遥远的地方恢复清醒",
  "恐惧症：获得一种持续性恐惧",
  "狂躁症：获得一种持续性强迫冲动",
];

function integerConfig(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function die(sides) {
  return 1 + Math.floor(Math.random() * sides);
}

function diceSum(count, sides) {
  return Array.from({ length: count }, () => die(sides)).reduce((sum, value) => sum + value, 0);
}

function normalizedDiceText(value) {
  return String(value || "").normalize("NFKC");
}

function defaultDieSides(expression, config = {}) {
  const maxSides = integerConfig(config.maxSides, 1000, 2, 10000);
  const match = /(?:^|[^\d])(?:\d*)d(\d+)/i.exec(normalizedDiceText(expression));
  const fallback = Math.min(100, maxSides);
  const sides = Number(match?.[1] || fallback);
  return Number.isInteger(sides) && sides >= 2 && sides <= maxSides ? sides : fallback;
}

function parseExpressionSyntax(input, config = {}, defaultSides = 100) {
  const source = normalizedDiceText(input);
  if (!source.trim()) return null;
  if (source.length > 512) throw new Error("骰娘参数过长");
  const maxDice = integerConfig(config.maxDice, 20, 1, 100);
  const maxSides = integerConfig(config.maxSides, 1000, 2, 10000);
  let offset = 0;
  let diceCount = 0;
  let nodeCount = 0;
  let depth = 0;

  const node = (value) => {
    nodeCount += 1;
    if (nodeCount > 64) throw new Error("骰式过于复杂");
    return value;
  };
  const skipSpaces = () => {
    while (/\s/u.test(source[offset] || "")) offset += 1;
  };

  function parsePrimary() {
    skipSpaces();
    const start = offset;
    if (source[offset] === "(") {
      depth += 1;
      if (depth > 12) throw new Error("骰式括号最多嵌套 12 层");
      offset += 1;
      const value = parseAdditive();
      skipSpaces();
      if (!value || source[offset] !== ")") throw new Error("骰式括号不匹配");
      offset += 1;
      depth -= 1;
      return node({ type: "group", value });
    }

    const diceMatch = /^(\d*)d(%|\d*)/i.exec(source.slice(offset));
    if (diceMatch) {
      const next = source[offset + diceMatch[0].length] || "";
      if (!diceMatch[1] && !diceMatch[2] && /[A-Za-z_]/.test(next)) {
        offset = start;
      } else {
        const count = Number(diceMatch[1] || 1);
        const sides = diceMatch[2] === "%" ? 100 : Number(diceMatch[2] || defaultSides);
        if (!Number.isInteger(count) || count < 1 || diceCount + count > maxDice) {
          throw new Error(`单次最多掷 ${maxDice} 颗骰子`);
        }
        if (!Number.isInteger(sides) || sides < 2 || sides > maxSides) {
          throw new Error(`骰子面数必须在 2 到 ${maxSides} 之间`);
        }
        offset += diceMatch[0].length;
        let keepMode = "";
        let keepCount = 0;
        const keepMatch = /^(kh|kl|k|q)(\d*)/i.exec(source.slice(offset));
        if (keepMatch) {
          const afterKeep = source[offset + keepMatch[0].length] || "";
          if (keepMatch[2] || !/[A-Za-z_]/.test(afterKeep)) {
            keepMode = /^(k|kh)$/i.test(keepMatch[1]) ? "high" : "low";
            keepCount = Number(keepMatch[2] || 1);
            if (!Number.isInteger(keepCount) || keepCount < 1 || keepCount > count) {
              throw new Error("保留骰数量必须在 1 到骰子总数之间");
            }
            offset += keepMatch[0].length;
          }
        }
        diceCount += count;
        return node({ type: "dice", count, sides, keepMode, keepCount });
      }
    }

    const bonusMatch = /^([bp])(\d*)/i.exec(source.slice(offset));
    if (bonusMatch) {
      const next = source[offset + bonusMatch[0].length] || "";
      if (bonusMatch[2] || !/[A-Za-z_]/.test(next)) {
        const extra = Number(bonusMatch[2] || 1);
        if (!Number.isInteger(extra) || extra < 1 || extra > 10 || diceCount + extra + 2 > maxDice) {
          throw new Error("奖励骰或惩罚骰最多 10 颗，且不能超过单次骰子上限");
        }
        offset += bonusMatch[0].length;
        diceCount += extra + 2;
        return node({ type: "percentile", mode: bonusMatch[1].toLowerCase() === "b" ? "bonus" : "penalty", extra });
      }
    }

    const numberMatch = /^\d+/.exec(source.slice(offset));
    if (numberMatch) {
      const value = Number(numberMatch[0]);
      if (!Number.isSafeInteger(value) || value > 100000) throw new Error("常数不能超过 100000");
      offset += numberMatch[0].length;
      return node({ type: "number", value });
    }
    offset = start;
    return null;
  }

  function parseUnary() {
    const start = offset;
    skipSpaces();
    if (["+", "-"].includes(source[offset])) {
      const operator = source[offset];
      offset += 1;
      const value = parseUnary();
      if (!value) throw new Error("骰式运算符后缺少数值");
      return node({ type: "unary", operator, value });
    }
    offset = start;
    return parsePower();
  }

  function parsePower() {
    let value = parsePrimary();
    if (!value) return null;
    const start = offset;
    skipSpaces();
    if (source[offset] !== "^") {
      offset = start;
      return value;
    }
    offset += 1;
    const right = parseUnary();
    if (!right) throw new Error("骰式运算符后缺少数值");
    return node({ type: "binary", operator: "^", left: value, right });
  }

  function parseMultiplicative() {
    let value = parseUnary();
    if (!value) return null;
    while (true) {
      const start = offset;
      skipSpaces();
      const rawOperator = source[offset] || "";
      const operator = ["*", "x", "X", "×"].includes(rawOperator) ? "*" : (["/", "÷"].includes(rawOperator) ? "/" : "");
      if (!operator) {
        offset = start;
        break;
      }
      offset += 1;
      const right = parseUnary();
      if (!right && ["x", "X", "×"].includes(rawOperator)) {
        offset = start;
        break;
      }
      if (!right) throw new Error("骰式运算符后缺少数值");
      value = node({ type: "binary", operator, left: value, right });
    }
    return value;
  }

  function parseAdditive() {
    let value = parseMultiplicative();
    if (!value) return null;
    while (true) {
      const start = offset;
      skipSpaces();
      const operator = ["+", "-"].includes(source[offset]) ? source[offset] : "";
      if (!operator) {
        offset = start;
        break;
      }
      offset += 1;
      const right = parseMultiplicative();
      if (!right) throw new Error("骰式运算符后缺少数值");
      value = node({ type: "binary", operator, left: value, right });
    }
    return value;
  }

  skipSpaces();
  const start = offset;
  const ast = parseAdditive();
  if (!ast) return null;
  const end = offset;
  if (source.slice(start, end).replace(/\s+/g, "").length > 96) throw new Error("骰式不能超过 96 个字符");
  return { source, ast, start, end, diceCount };
}

function expressionPrecedence(node) {
  if (node.type === "binary") return node.operator === "^" ? 3 : (["*", "/"].includes(node.operator) ? 2 : 1);
  if (node.type === "unary") return 4;
  return 5;
}

function renderExpressionNode(node) {
  if (node.type === "literal") return node.text;
  if (node.type === "number") return String(node.value);
  if (node.type === "dice") {
    const keep = node.keepMode === "high" ? `k${node.keepCount}` : (node.keepMode === "low" ? `q${node.keepCount}` : "");
    return `${node.count}d${node.sides}${keep}`;
  }
  if (node.type === "percentile") return `${node.mode === "bonus" ? "b" : "p"}${node.extra === 1 ? "" : node.extra}`;
  if (node.type === "group") return `(${renderExpressionNode(node.value)})`;
  if (node.type === "unary") {
    const rendered = renderExpressionNode(node.value);
    return `${node.operator}${expressionPrecedence(node.value) < expressionPrecedence(node) ? `(${rendered})` : rendered}`;
  }
  const child = (value, side) => {
    const rendered = renderExpressionNode(value);
    if (value.type === "group" || value.type !== "binary") return rendered;
    const parentPrecedence = expressionPrecedence(node);
    const childPrecedence = expressionPrecedence(value);
    const equalNeedsParentheses = side === "left"
      ? node.operator === "^" && childPrecedence === parentPrecedence
      : ["-", "/"].includes(node.operator) && childPrecedence === parentPrecedence;
    return childPrecedence < parentPrecedence || equalNeedsParentheses ? `(${rendered})` : rendered;
  };
  return `${child(node.left, "left")}${node.operator}${child(node.right, "right")}`;
}

function evaluateExpressionNode(node) {
  if (node.type === "number") return { value: node.value, detail: { type: "literal", text: String(node.value) } };
  if (node.type === "dice") {
    const rolls = Array.from({ length: node.count }, () => die(node.sides));
    const selected = node.keepMode
      ? [...rolls].sort((left, right) => node.keepMode === "high" ? right - left : left - right).slice(0, node.keepCount)
      : rolls;
    const value = selected.reduce((sum, roll) => sum + roll, 0);
    const detail = node.keepMode ? `[${rolls.join(",")} -> ${selected.join("+")}]` : `[${rolls.join("+")}]`;
    return { value, detail: { type: "literal", text: detail } };
  }
  if (node.type === "percentile") {
    const result = percentileRoll(node.mode, node.extra);
    return { value: result.roll, detail: { type: "literal", text: `[${result.candidates.join("/")}]` } };
  }
  if (node.type === "group") {
    const result = evaluateExpressionNode(node.value);
    return { value: result.value, detail: { type: "group", value: result.detail } };
  }
  if (node.type === "unary") {
    const result = evaluateExpressionNode(node.value);
    return {
      value: node.operator === "-" ? -result.value : result.value,
      detail: { type: "unary", operator: node.operator, value: result.detail },
    };
  }
  const left = evaluateExpressionNode(node.left);
  const right = evaluateExpressionNode(node.right);
  if (node.operator === "/" && right.value === 0) throw new Error("骰式不能除以 0");
  if (node.operator === "^" && (!Number.isSafeInteger(right.value) || right.value < 0 || right.value > 1000)) {
    throw new Error("骰式指数必须是 0 到 1000 之间的整数");
  }
  const operations = {
    "+": () => left.value + right.value,
    "-": () => left.value - right.value,
    "*": () => left.value * right.value,
    "/": () => Math.trunc(left.value / right.value),
    "^": () => left.value ** right.value,
  };
  const value = operations[node.operator]();
  if (!Number.isSafeInteger(value)) throw new Error("骰式计算结果超出安全范围");
  return {
    value: Object.is(value, -0) ? 0 : value,
    detail: { type: "binary", operator: node.operator, left: left.detail, right: right.detail },
  };
}

function parseExpression(input, config, defaultSides = 100) {
  const parsed = parseExpressionSyntax(input, config, defaultSides);
  if (!parsed || parsed.source.slice(parsed.end).trim()) throw new Error("骰式格式不正确");
  const evaluated = evaluateExpressionNode(parsed.ast);
  return {
    expression: renderExpressionNode(parsed.ast),
    detail: renderExpressionNode(evaluated.detail),
    total: evaluated.value,
    diceCount: parsed.diceCount,
  };
}

function isCompleteExpression(value, config = {}, defaultSides = 100) {
  try {
    const parsed = parseExpressionSyntax(value, config, defaultSides);
    return !!parsed && !parsed.source.slice(parsed.end).trim();
  } catch {
    return false;
  }
}

function dataBackedApi(ctx) {
  const original = ctx.api;
  if (typeof original.database !== "function") return original;
  const oldValues = new Map();
  const location = (key, scope = "chat") => {
    if (key === "character" && scope === "groupUser") {
      const userId = String(ctx.principal?.senderId || ctx.message?.sender?.id || "");
      if (!userId) throw new Error("无法识别角色卡所属用户");
      return { collection: "characters", key: userId };
    }
    if (scope === "chat" && key === "stats") return { collection: "statistics", key: "total" };
    if (scope === "chat" && key === "defaultExpression") return { collection: "settings", key };
    throw new Error("骰娘数据范围无效");
  };
  const update = async (key, reducer, scope = "chat", read = false) => {
    const target = location(key, scope);
    for (let attempt = 0; attempt < 64; attempt++) {
      const { record } = await original.database({ name: "dice", scope: "chat", action: "get", ...target });
      if (read && record) return record.value;
      const cacheKey = `${scope}:${key}`;
      if (!record && !oldValues.has(cacheKey)) oldValues.set(cacheKey, original.getState(key, scope));
      const previous = record ? record.value : await oldValues.get(cacheKey) ?? null;
      const value = read ? previous : reducer(previous);
      try {
        const saved = await original.database({ name: "dice", scope: "chat", action: "put", ...target,
          value, expectedRevision: record?.revision || 0 });
        return saved.record.value;
      } catch (error) {
        if (!String(error?.message).includes("记录已改变")) throw error;
      }
    }
    throw new Error("骰娘数据更新繁忙，请稍后重试");
  };
  return { ...original,
    getState: (key, scope) => update(key, null, scope, true),
    setState: (key, value, scope) => update(key, () => value, scope),
    updateState: (key, reducer, scope) => update(key, reducer, scope),
  };
}

function response(config, text) {
  const blocks = [];
  if (config.replyToSource === true) blocks.push({ type: "reply", messageId: "current" });
  blocks.push({ type: "text", text });
  return { blocks };
}

async function record(api, config, kind, diceCount, expression, total) {
  if (config.statsEnabled === false) return;
  if (typeof api.updateState !== "function") throw new Error("请更新 OpenBot 后使用骰娘统计，或暂时关闭统计");
  await api.updateState("stats", saved => {
    const current = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    const byKind = current.byKind && typeof current.byKind === "object" && !Array.isArray(current.byKind) ? current.byKind : {};
    return {
    commands: Number(current.commands || 0) + 1,
    dice: Number(current.dice || 0) + diceCount,
    byKind: { ...byKind, [kind]: Number(byKind[kind] || 0) + 1 },
    lastPublicExpression: kind === "hidden" ? String(current.lastPublicExpression || "") : expression,
    lastPublicTotal: kind === "hidden" ? current.lastPublicTotal : total,
    updatedAt: Date.now(),
    };
  });
}

function cocLevel(skill, roll) {
  if (roll === 1) return "大成功";
  if (roll >= (skill < 50 ? 96 : 100)) return "大失败";
  if (roll <= Math.floor(skill / 5)) return "极难成功";
  if (roll <= Math.floor(skill / 2)) return "困难成功";
  if (roll <= skill) return "成功";
  return "失败";
}

function bonusMode(token) {
  const match = /^(b|bonus|奖励|奖励骰|p|penalty|惩罚|惩罚骰)(\d*)$/i.exec(String(token || ""));
  if (!match) return null;
  return {
    mode: /^(b|bonus|奖励|奖励骰)$/i.test(match[1]) ? "bonus" : "penalty",
    count: Number(match[2] || 1),
  };
}

function percentileRoll(mode = "", extra = 0) {
  const units = die(10) - 1;
  const tens = Array.from({ length: extra + 1 }, () => die(10) - 1);
  const candidates = tens.map((value) => {
    const result = value * 10 + units;
    return result === 0 ? 100 : result;
  });
  const roll = mode === "bonus" ? Math.min(...candidates) : (mode === "penalty" ? Math.max(...candidates) : candidates[0]);
  return { roll, candidates, diceCount: tens.length + 1 };
}

function normalizedStatName(value) {
  const name = String(value || "").trim();
  return /^[A-Za-z]+$/.test(name) ? name.toUpperCase() : name;
}

async function characterFor(api) {
  const saved = await api.getState("character", "groupUser");
  return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
}

function characterStat(character, name) {
  const target = normalizedStatName(name);
  const key = Object.keys(character).find((item) => normalizedStatName(item) === target);
  return key ? { key, value: Number(character[key]) } : null;
}

async function saveCharacter(api, change) {
  if (typeof api.updateState === "function") return api.updateState("character", saved => {
    const current = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    return typeof change === "function" ? change(current) : change;
  }, "groupUser");
  const value = typeof change === "function" ? change(await characterFor(api)) : change;
  await api.setState("character", value, "groupUser");
  return value;
}

function statPairs(args) {
  return [...String(args || "").matchAll(/([^\s:=\d]+)\s*[:=]?\s*(\d{1,3})(?=\s|$)/gu)].map((match) => ({
    name: normalizedStatName(match[1]),
    value: Number(match[2]),
  }));
}

async function characterCommand(api, args) {
  const input = String(args || "").trim();
  let character = await characterFor(api);
  if (/^(clear|reset|清空)$/i.test(input)) {
    await saveCharacter(api, {});
    return "已清空当前群内角色卡";
  }
  const deleteMatch = /^(?:del|delete|删除)\s+(.+)$/i.exec(input);
  if (deleteMatch) {
    const stat = characterStat(character, deleteMatch[1]);
    if (!stat) throw new Error(`角色卡中没有 ${deleteMatch[1]}`);
    character = await saveCharacter(api, current => {
      const next = { ...current }; delete next[stat.key]; return next;
    });
  } else if (input && !/^(show|list|查看)$/i.test(input)) {
    const pairs = statPairs(input);
    if (!pairs.length) throw new Error("用法：.st 侦查 60 SAN 70");
    const changes = {};
    for (const pair of pairs) {
      if (pair.value < 0 || pair.value > 999) throw new Error(`${pair.name} 必须在 0 到 999 之间`);
      changes[pair.name] = pair.value;
    }
    character = await saveCharacter(api, current => ({ ...current, ...changes }));
  }
  const entries = Object.entries(character);
  return entries.length ? `当前群内角色卡：${entries.map(([name, value]) => `${name} ${value}`).join("，")}` : "当前群内还没有角色卡；使用 .st 侦查 60 SAN 70 设置";
}

function parseCocCheckInput(args, character) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  let mode = "";
  let extra = 0;
  let difficulty = "普通";
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const bonus = bonusMode(parts[index]);
    if (bonus) {
      mode = bonus.mode;
      extra = bonus.count;
      parts.splice(index, 1);
    } else if (["普通", "困难", "极难"].includes(parts[index])) {
      difficulty = parts[index];
      parts.splice(index, 1);
    }
  }
  if (extra > 2) throw new Error("奖励骰或惩罚骰最多 2 颗");
  const numberIndex = parts.findIndex((part) => /^\d{1,3}$/.test(part));
  let skill = numberIndex >= 0 ? Number(parts[numberIndex]) : 0;
  if (numberIndex >= 0) parts.splice(numberIndex, 1);
  const skillName = parts.join(" ").trim();
  if (!skill && skillName) skill = characterStat(character, skillName)?.value || 0;
  if (!Number.isInteger(skill) || skill < 1 || skill > 100) {
    throw new Error("用法：.ra [b1|p1] [普通|困难|极难] [技能名] <技能值>；也可先用 .st 保存技能值");
  }
  return { mode, extra, difficulty, skill, skillName };
}

async function cocCheck(api, args) {
  const character = await characterFor(api);
  const input = parseCocCheckInput(args, character);
  const result = percentileRoll(input.mode, input.extra);
  const threshold = input.difficulty === "困难"
    ? Math.floor(input.skill / 2)
    : (input.difficulty === "极难" ? Math.floor(input.skill / 5) : input.skill);
  const baseLevel = cocLevel(input.skill, result.roll);
  const outcome = input.difficulty === "普通"
    ? baseLevel
    : `${input.difficulty}${result.roll <= threshold ? "成功" : "失败"}（${baseLevel}）`;
  const subject = input.skillName ? `${input.skillName}检定` : "CoC 检定";
  return {
    roll: result.roll,
    diceCount: result.diceCount,
    text: `${subject} ${input.skill}：${result.roll}，${outcome}${input.extra ? `（候选 ${result.candidates.join("/")}）` : ""}`,
  };
}

function opposedCheck(args) {
  const matches = [...String(args || "").matchAll(/(?:(\S+)\s+)?(\d{1,3})/gu)];
  if (matches.length !== 2) throw new Error("用法：.rav 侦查 60 潜行 45，或 .rav 60 45");
  const sides = matches.map((match, index) => ({
    name: match[1] && !/^\d+$/.test(match[1]) ? match[1] : `对抗方 ${index + 1}`,
    skill: Number(match[2]),
    roll: die(100),
  }));
  if (sides.some((side) => side.skill < 1 || side.skill > 100)) throw new Error("对抗技能值必须在 1 到 100 之间");
  const rank = { 大失败: 0, 失败: 1, 成功: 2, 困难成功: 3, 极难成功: 4, 大成功: 5 };
  for (const side of sides) side.level = cocLevel(side.skill, side.roll);
  let winner = "平局";
  if (rank[sides[0].level] !== rank[sides[1].level]) {
    winner = rank[sides[0].level] > rank[sides[1].level] ? sides[0].name : sides[1].name;
  } else if (rank[sides[0].level] > 1 && sides[0].skill !== sides[1].skill) {
    winner = sides[0].skill > sides[1].skill ? sides[0].name : sides[1].name;
  }
  return {
    diceCount: 2,
    total: sides[0].roll + sides[1].roll,
    text: `${sides[0].name} ${sides[0].skill}：${sides[0].roll}（${sides[0].level}）；${sides[1].name} ${sides[1].skill}：${sides[1].roll}（${sides[1].level}）；结果：${winner}`,
  };
}

function cleanReason(value) {
  return String(value || "").trim().replace(/^[:：]\s*/, "");
}

function parseRollRequest(input, config, configuredDefault) {
  let source = normalizedDiceText(input).trim();
  const defaultSides = defaultDieSides(configuredDefault, config);
  const maxRolls = integerConfig(config.maxRolls, 10, 1, 20);
  const maxDice = integerConfig(config.maxDice, 20, 1, 100);
  let repeat = 1;
  const repeatMatch = /^(\d+)\s*#\s*/.exec(source);
  if (repeatMatch) {
    repeat = Number(repeatMatch[1]);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > maxRolls) throw new Error(`单次最多重复 ${maxRolls} 次`);
    source = source.slice(repeatMatch[0].length);
    if (!source) throw new Error("重复掷骰缺少骰式");
  }

  let parsed = source ? parseExpressionSyntax(source, config, defaultSides) : null;
  let reason = "";
  let candidateError = null;
  if (parsed) {
    reason = cleanReason(source.slice(parsed.end));
  } else if (source) {
    const boundaries = new Set();
    for (const match of source.matchAll(/\s+/g)) boundaries.add(match.index + match[0].length);
    for (let index = 0; index < source.length; index += 1) {
      if ([":", "："].includes(source[index])) boundaries.add(index + 1);
    }
    for (const boundary of [...boundaries].sort((left, right) => left - right)) {
      let candidate = source.slice(boundary).trim();
      let candidateRepeat = 1;
      const candidateRepeatMatch = /^(\d+)\s*#\s*/.exec(candidate);
      if (candidateRepeatMatch) {
        candidateRepeat = Number(candidateRepeatMatch[1]);
        candidate = candidate.slice(candidateRepeatMatch[0].length);
      }
      try {
        if (!Number.isInteger(candidateRepeat) || candidateRepeat < 1 || candidateRepeat > maxRolls) {
          throw new Error(`单次最多重复 ${maxRolls} 次`);
        }
        const candidateParsed = parseExpressionSyntax(candidate, config, defaultSides);
        if (candidateParsed && !candidateParsed.source.slice(candidateParsed.end).trim()) {
          parsed = candidateParsed;
          repeat = candidateRepeat;
          reason = source.slice(0, boundary).trim().replace(/[:：]\s*$/, "");
          break;
        }
      } catch (error) {
        if (/^[\d()+\-bdp]/i.test(candidate)) candidateError = error;
      }
    }
  }

  if (!parsed) {
    if (candidateError) throw candidateError;
    if (repeat > 1) throw new Error("重复掷骰缺少有效骰式");
    parsed = parseExpressionSyntax(configuredDefault, config, defaultSides);
    if (!parsed || parsed.source.slice(parsed.end).trim()) throw new Error("默认骰式格式不正确");
    reason = source;
  }
  if (parsed.diceCount * repeat > maxDice) throw new Error(`单次最多掷 ${maxDice} 颗骰子`);
  return { parsed, reason, repeat };
}

async function generalRoll(api, config, args, command = {}) {
  let rawArgs = normalizedDiceText(args).trim();
  if (/^(help|帮助)$/i.test(rawArgs)) return { help: true, text: HELP };
  const invokedName = String(command.invokedName || "").toLowerCase();
  const diceShortcuts = ["d", "rd", "rh", "rhd", "rdh", "roll", "掷骰", "暗骰"];
  if (command.attachedArgs && ["d", "rd", "rh", "rhd", "rdh", "暗骰"].includes(invokedName)) {
    rawArgs = `d${rawArgs}`;
  } else if (diceShortcuts.includes(invokedName)) {
    if (/^\d+(?=$|\s|[+\-*/^x×÷])/i.test(rawArgs) || /^[+\-*/^x×÷]/i.test(rawArgs)) rawArgs = `d${rawArgs}`;
  }
  const chatDefault = await api.getState("defaultExpression");
  const configuredDefault = normalizedDiceText(chatDefault || config.defaultExpression || "1d100");
  const request = parseRollRequest(rawArgs, config, configuredDefault);
  const expression = renderExpressionNode(request.parsed.ast);
  const rolls = Array.from({ length: request.repeat }, () => {
    const evaluated = evaluateExpressionNode(request.parsed.ast);
    return { total: evaluated.value, detail: renderExpressionNode(evaluated.detail) };
  });
  const reason = request.reason ? `${request.reason}：` : "";
  if (request.repeat === 1) {
    if (request.parsed.diceCount === 0) {
      const calculation = expression === rolls[0].detail && expression === String(rolls[0].total)
        ? expression
        : `${expression} = ${rolls[0].total}`;
      return {
        expression,
        detail: rolls[0].detail,
        total: rolls[0].total,
        diceCount: 0,
        text: `${reason}计算结果：${calculation}`,
      };
    }
    const detail = config.showDetails === false ? "" : ` = ${rolls[0].detail}`;
    return {
      expression,
      detail: rolls[0].detail,
      total: rolls[0].total,
      diceCount: request.parsed.diceCount,
      text: `${reason}${expression}${detail} = ${rolls[0].total}`,
    };
  }
  const lines = rolls.map((roll, index) => {
    const detail = config.showDetails === false ? "" : ` = ${roll.detail}`;
    return `${index + 1}. ${expression}${detail} = ${roll.total}`;
  });
  return {
    expression: `${request.repeat}#${expression}`,
    detail: rolls.map((roll) => roll.detail).join(" / "),
    total: rolls.map((roll) => roll.total).join("/"),
    diceCount: request.parsed.diceCount * request.repeat,
    text: `${reason}${request.repeat}#${expression}\n${lines.join("\n")}`,
  };
}

async function sanityCheck(api, config, args) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const loss = parts.shift() || "";
  const lossParts = loss.split("/");
  const defaultSides = defaultDieSides(config.defaultExpression || "1d100", config);
  if (lossParts.length > 2 || !lossParts.every((part) => isCompleteExpression(part, config, defaultSides))) {
    throw new Error("用法：.sc 1/1d6 [当前 SAN]");
  }
  const character = await characterFor(api);
  const explicitSan = parts.find((part) => /^\d{1,3}$/.test(part));
  const currentSan = explicitSan ? Number(explicitSan) : (characterStat(character, "SAN")?.value || 0);
  if (!Number.isInteger(currentSan) || currentSan < 1 || currentSan > 99) throw new Error("请提供当前 SAN，或先用 .st SAN 60 设置");
  const result = percentileRoll();
  const success = result.roll <= currentSan;
  const lossExpression = lossParts.length === 1 ? (success ? "0" : lossParts[0]) : (success ? lossParts[0] : lossParts[1]);
  const lossRoll = parseExpression(lossExpression, config, defaultSides);
  const nextSan = Math.max(0, currentSan - Math.max(0, lossRoll.total));
  await saveCharacter(api, current => ({ ...current, SAN: nextSan }));
  return {
    roll: result.roll,
    diceCount: result.diceCount + lossRoll.diceCount,
    text: `理智检定 ${currentSan}：${result.roll}，${success ? "成功" : "失败"}；损失 ${lossRoll.expression} = ${lossRoll.total}，SAN ${currentSan} -> ${nextSan}`,
  };
}

async function growthCheck(api, args) {
  const character = await characterFor(api);
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const explicitIndex = parts.findIndex((part) => /^\d{1,3}$/.test(part));
  const explicit = explicitIndex >= 0 ? Number(parts.splice(explicitIndex, 1)[0]) : 0;
  const name = parts.join(" ").trim();
  const saved = name ? characterStat(character, name) : null;
  const skill = explicit || saved?.value || 0;
  if (!name || skill < 1 || skill > 99) throw new Error("用法：.en 技能名 [技能值]；也可先用 .st 保存技能值");
  const roll = die(100);
  const success = roll > skill || roll >= 96;
  const gain = success ? die(10) : 0;
  const next = Math.min(99, skill + gain);
  if (success) await saveCharacter(api, current => ({ ...current, [saved?.key || normalizedStatName(name)]: next }));
  return {
    roll,
    diceCount: success ? 2 : 1,
    text: `${name}成长检定：${roll}，${success ? `成功，成长 1d10 = ${gain}，${skill} -> ${next}` : `失败，维持 ${skill}`}`,
  };
}

function d20Roll(args) {
  const input = String(args || "").trim();
  const compact = /^(adv(?:antage)?|dis(?:advantage)?|优势|劣势)([+-]\d+)?$/i.exec(input);
  const parts = compact ? compact.slice(1).filter(Boolean) : input.split(/\s+/).filter(Boolean);
  let mode = "";
  let modifier = 0;
  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (["adv", "advantage", "优势"].includes(lowered)) mode = "advantage";
    else if (["dis", "disadvantage", "劣势"].includes(lowered)) mode = "disadvantage";
    else if (/^[+-]\d+$/.test(part)) modifier = Number(part);
    else throw new Error("用法：/d20 [adv|dis] [+/-加值]");
  }
  if (!mode) throw new Error("用法：/d20 [adv|dis] [+/-加值]");
  if (!Number.isSafeInteger(modifier) || Math.abs(modifier) > 1000) throw new Error("D20 加值范围为 -1000 到 1000");
  const rolls = Array.from({ length: 2 }, () => die(20));
  const selected = mode === "advantage" ? Math.max(...rolls) : Math.min(...rolls);
  const total = selected + modifier;
  const modifierText = modifier ? `${modifier > 0 ? "+" : ""}${modifier}` : "";
  const modeText = mode === "advantage" ? "优势" : "劣势";
  const selectedText = mode === "advantage" ? "较高值" : "较低值";
  return {
    total,
    diceCount: rolls.length,
    text: `D20 ${modeText}：掷出 ${rolls.join(" / ")}，取${selectedText} ${selected}${modifierText}${modifier ? ` = ${total}` : ""}`,
  };
}

function cocCharacter() {
  const attributes = {
    力量: diceSum(3, 6) * 5,
    敏捷: diceSum(3, 6) * 5,
    意志: diceSum(3, 6) * 5,
    体质: diceSum(3, 6) * 5,
    外貌: diceSum(3, 6) * 5,
    教育: (diceSum(2, 6) + 6) * 5,
    体型: (diceSum(2, 6) + 6) * 5,
    智力: (diceSum(2, 6) + 6) * 5,
    幸运: diceSum(3, 6) * 5,
  };
  const hp = Math.floor((attributes.体质 + attributes.体型) / 10);
  return `${Object.entries(attributes).map(([name, value]) => `${name} ${value}`).join("，")}，HP ${hp}`;
}

module.exports.handle = async function handle(ctx) {
  const config = ctx.config || {};
  const command = String(ctx.command?.name || "roll").toLowerCase();
  const args = normalizedDiceText(ctx.args).trim();
  try {
    ctx = { ...ctx, api: dataBackedApi(ctx) };
    if (command === "dicehelp") return response(config, HELP);
    if (command === "dicestats") {
      if (config.statsEnabled === false) return response(config, "当前已关闭掷骰统计");
      const stats = await ctx.api.getState("stats");
      if (!stats || !stats.commands) return response(config, "当前群或私聊还没有掷骰记录");
      const last = stats.lastPublicExpression ? `；上次公开结果为 ${stats.lastPublicExpression} = ${stats.lastPublicTotal}` : "";
      return response(config, `本会话共执行 ${stats.commands} 次，掷出 ${stats.dice || 0} 颗骰子${last}`);
    }
    if (command === "st") return response(config, await characterCommand(ctx.api, args));
    if (command === "dset") {
      let value = args;
      if (!value || /^(reset|clear|继承)$/i.test(value)) {
        await ctx.api.setState("defaultExpression", "");
        return response(config, "已恢复机器人默认骰式");
      }
      if (/^\d+$/.test(value)) value = `1d${value}`;
      const defaultSides = defaultDieSides(config.defaultExpression || "1d100", config);
      if (!isCompleteExpression(value, config, defaultSides)) throw new Error("用法：.set 20、.dset 1d20，或 .set reset");
      const parsed = parseExpression(value, config, defaultSides);
      await ctx.api.setState("defaultExpression", parsed.expression);
      return response(config, `已设置本会话默认骰式：${parsed.expression}`);
    }
    if (["ra", "coc"].includes(command)) {
      const result = await cocCheck(ctx.api, args);
      await record(ctx.api, config, "coc", result.diceCount, `${command}:${args}`, result.roll);
      return response(config, result.text);
    }
    if (command === "rav") {
      const result = opposedCheck(args);
      await record(ctx.api, config, "rav", result.diceCount, `rav:${args}`, result.total);
      return response(config, result.text);
    }
    if (command === "sc") {
      const result = await sanityCheck(ctx.api, config, args);
      await record(ctx.api, config, "sc", result.diceCount, `sc:${args}`, result.roll);
      return response(config, result.text);
    }
    if (command === "en") {
      const result = await growthCheck(ctx.api, args);
      await record(ctx.api, config, "en", result.diceCount, `en:${args}`, result.roll);
      return response(config, result.text);
    }
    if (["ti", "li"].includes(command)) {
      const roll = die(10);
      const duration = die(10);
      const temporary = command === "ti";
      const text = (temporary ? TEMPORARY_INSANITY : LONG_TERM_INSANITY)[roll - 1];
      await record(ctx.api, config, command, 2, command, roll);
      return response(config, `${temporary ? "临时" : "总结性"}疯狂 1d10 = ${roll}：${text}（持续参考 1d10 = ${duration} ${temporary ? "轮" : "小时"}）`);
    }
    if (command === "cocchar") {
      const count = integerConfig(args || 1, 1, 1, integerConfig(config.maxCardCount, 3, 1, 10));
      const cards = Array.from({ length: count }, (_, index) => `${count > 1 ? `${index + 1}. ` : ""}${cocCharacter()}`);
      await record(ctx.api, config, "cocchar", count * 24, `cocchar:${count}`, count);
      return response(config, cards.join("\n"));
    }
    if (command === "d20") {
      const specialMode = /^(?:adv(?:antage)?|dis(?:advantage)?|优势|劣势)(?:\s*[+-]\d+)?$/i.test(args);
      const result = specialMode
        ? d20Roll(args)
        : await generalRoll(ctx.api, config, `d20${args ? ` ${args}` : ""}`, { invokedName: "r" });
      await record(ctx.api, config, "d20", result.diceCount, `d20:${args || "normal"}`, result.total);
      return response(config, result.text);
    }

    if (command === "rh") {
      const isGroup = String(ctx.message?.chatId || "").startsWith("onebot:group:");
      if (isGroup && ctx.api.getCapabilities && !(await ctx.api.getCapabilities()).groupMemberPrivateMessage) {
        return response(config, "当前实例无法从群聊向成员发起私聊，请在与机器人的私聊中使用暗骰。");
      }
      const result = await generalRoll(ctx.api, config, args, ctx.command);
      if (result.help) return response(config, result.text);
      await record(ctx.api, config, "hidden", result.diceCount, result.expression, result.total);
      const senderId = String(ctx.principal?.senderId || ctx.message?.sender?.id || "");
      if (isGroup) {
        if (!senderId) throw new Error("无法识别暗骰用户");
        await ctx.api.callNapCat("send_private_msg", { user_id: senderId, message: [{ type: "text", data: { text: `暗骰结果：${result.text}` } }] });
        return response(config, "暗骰结果已私聊发送");
      }
      return response(config, `暗骰结果：${result.text}`);
    }

    const result = await generalRoll(ctx.api, config, args, ctx.command);
    if (result.help) return response(config, result.text);
    await record(ctx.api, config, "roll", result.diceCount, result.expression, result.total);
    return response(config, result.text);
  } catch (error) {
    return response(config, `骰娘：${error && error.message ? error.message : String(error)}`);
  }
};

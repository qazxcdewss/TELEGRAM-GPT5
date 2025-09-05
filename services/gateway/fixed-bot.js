module.exports.handleUpdate = async function (ctx) {
    const SPEC = {
      commands: [{ cmd: "/start", flow: "start" }],
      flows: [
        {
          name: "start",
          steps: [{ text: "Привет!", type: "sendMessage" }]
        }
      ],
      meta: { botId: "my-bot-1", name: "HelloWorldBot", schema_ver: "1.0.0" }
    };
  
    // helper БЕЗ await/ctx-побочек — только извлекаем строку
    function extractText(c) {
      if (!c) return "";
      if (typeof c.text === "string") return c.text;
      if (c.message && typeof c.message.text === "string") return c.message.text;
      if (c.update && c.update.message && typeof c.update.message.text === "string") return c.update.message.text;
      if (c.update && c.update.callback_query && typeof c.update.callback_query.data === "string") return c.update.callback_query.data;
      return "";
    }
  
    function findFlow(name) {
      return SPEC.flows.find(f => f.name === name) || null;
    }
  
    async function saveState(state) {
      await ctx.setState(state);
    }
  
    async function getState() {
      const s = await ctx.getState();
      return s && typeof s === "object" ? s : {};
    }
  
    async function startFlow(state, flowName, startStep) {
      const flow = findFlow(flowName);
      if (!flow) return state;
      state.flow = flowName;
      state.step = Number.isInteger(startStep) && startStep >= 0 ? startStep : 0;
      await saveState(state);
      return state;
    }
  
    async function runEngine(state) {
      let safetyCounter = 0;
      while (safetyCounter < 50) {
        safetyCounter += 1;
        if (!state.flow) break;
        const flow = findFlow(state.flow);
        if (!flow) {
          state.flow = null;
          state.step = 0;
          await saveState(state);
          break;
        }
        const steps = Array.isArray(flow.steps) ? flow.steps : [];
        const idx = Number.isInteger(state.step) ? state.step : 0;
        if (idx < 0 || idx >= steps.length) {
          state.flow = null;
          state.step = 0;
          await saveState(state);
          break;
        }
        const step = steps[idx] || {};
        const type = step.type || "sendMessage";
  
        if (type === "sendMessage") {
          const text = typeof step.text === "string" ? step.text : "";
          await ctx.sendMessage(text);
          state.step = idx + 1;
          await saveState(state);
          continue;
        }
  
        if (type === "goto") {
          const targetFlow = step.flow || step.toFlow || step.name || null;
          const targetStep = Number.isInteger(step.step) && step.step >= 0 ? step.step : 0;
          if (targetFlow && findFlow(targetFlow)) {
            state.flow = targetFlow;
            state.step = targetStep;
            await saveState(state);
            continue;
          } else {
            state.step = idx + 1;
            await saveState(state);
            continue;
          }
        }
  
        if (type === "http") {
          const req = {
            method: (step.method || "GET").toUpperCase(),
            url: step.url || "",
            headers: step.headers || undefined,
            body: step.body !== undefined ? step.body : undefined
          };
          let response = null;
          try {
            if (req.url) {
              response = await ctx.http({
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: req.body
              });
            }
          } catch (e) {
            response = { error: true, message: (e && e.message) ? e.message : String(e) };
          }
          if (step.save && typeof step.save === "string") {
            if (!state.vars || typeof state.vars !== "object") state.vars = {};
            state.vars[step.save] = response;
          }
          state.step = idx + 1;
          await saveState(state);
          continue;
        }
  
        state.step = idx + 1;
        await saveState(state);
      }
      return state;
    }
  
    const text = extractText(ctx);
    let state = await getState();
  
    const matchedCmd = SPEC.commands.find(c => {
      if (!text) return false;
      return text.trim().toLowerCase().startsWith(String(c.cmd || "").toLowerCase());
    });
  
    if (matchedCmd && matchedCmd.flow) {
      state = await startFlow(state, matchedCmd.flow, 0);
      await runEngine(state);
      return;
    }
  
    if (state && state.flow) {
      await runEngine(state);
      return;
    }
  
    return;
  };
  
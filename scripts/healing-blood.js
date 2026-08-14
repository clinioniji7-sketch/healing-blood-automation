const HB_EFFECT_NAME = "Healing Blood";
const CP_EFFECT_NAME = "Crimson Punishment";
const HB_FLAG_DAMAGE = "healingBloodDamage";
const HB_FLAG_SOURCE = "healingBloodLastDamageSource";
const CP_FLAG_TYPE = "crimsonPunishmentDamageType";
const HB_FLAG_SCOPE = "world";
const RECENT_SOURCE_MS = 60000;
const CRIMSON_RANGE_METERS = 6;

function hasEffect(actor, name) {
  return !!actor?.effects?.some(e => !e.disabled && e.name?.toLowerCase() === name.toLowerCase());
}
function hasHealingBlood(actor) { return hasEffect(actor, HB_EFFECT_NAME); }
function hasCrimsonPunishment(actor) { return hasEffect(actor, CP_EFFECT_NAME); }

function getHP(actor) {
  const hp = foundry.utils.getProperty(actor, "system.attributes.hp") ?? {};
  const value = Number(hp.value) || 0;
  const max = Number(hp.max) || 0;
  const tempmax = Number(hp.tempmax) || 0;
  return { value, max, tempmax, effectiveMax: Math.max(0, max + tempmax) };
}

async function changeHP(actor, delta) {
  if (!actor) return 0;
  const hp = getHP(actor);
  if (delta >= 0) {
    const amount = Math.max(0, Number(delta) || 0);
    const effective = Math.min(amount, Math.max(0, hp.effectiveMax - hp.value));
    if (effective <= 0) return 0;
    await actor.update({ "system.attributes.hp.value": hp.value + effective });
    return effective;
  }
  const damage = Math.max(0, Math.abs(Number(delta) || 0));
  const effective = Math.min(damage, Math.max(0, hp.value));
  if (effective <= 0) return 0;
  await actor.update({ "system.attributes.hp.value": Math.max(0, hp.value - effective) });
  return effective;
}

async function accumulateDamage(actor, amount) {
  amount = Math.max(0, Number(amount) || 0);
  if (!actor || amount <= 0) return;
  const current = Number(actor.getFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE)) || 0;
  await actor.setFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE, current + amount);
}
async function clearDamage(actor) { try { await actor?.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_DAMAGE); } catch (_) {} }

function getActorFromSpeaker(message) {
  const sceneId = message?.speaker?.scene, tokenId = message?.speaker?.token, actorId = message?.speaker?.actor;
  if (sceneId && tokenId) {
    const tokenDoc = game.scenes.get(sceneId)?.tokens?.get(tokenId);
    if (tokenDoc?.actor) return { actor: tokenDoc.actor, sceneId, tokenId };
  }
  if (tokenId) {
    const token = canvas.tokens?.get(tokenId);
    if (token?.actor) return { actor: token.actor, sceneId: canvas.scene?.id ?? null, tokenId };
  }
  const actor = actorId ? game.actors.get(actorId) : null;
  return actor ? { actor, sceneId: null, tokenId: null } : null;
}

function looksLikeDamageCard(message) {
  if (!message?.speaker?.actor) return false;
  const content = String(message.content ?? "").toLowerCase();
  const d = content.includes("dano") || content.includes("damage");
  const a = content.includes("aplicar") || content.includes("aplicado") || content.includes("apply");
  const r = Array.isArray(message.rolls) && message.rolls.length > 0;
  const f = !!message.flags?.dnd5e || !!message.flags?.["hunter-system"] || !!message.flags?.hunterSystem;
  return (d && a) || (d && r) || (d && f);
}

async function rememberChatDamageSource(message) {
  if (!looksLikeDamageCard(message)) return;
  const source = getActorFromSpeaker(message);
  if (!source?.actor) return;
  const data = { time: Date.now(), baseActorId: message.speaker?.actor ?? source.actor.id, sceneId: source.sceneId, tokenId: source.tokenId, alias: message.speaker?.alias ?? source.actor.name, messageId: message.id };
  const owner = game.actors.get(message.speaker?.actor) ?? game.actors.get(source.actor.id) ?? source.actor;
  try { await owner.setFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE, data); } catch (e) { console.warn("Healing Blood | Falha ao registrar fonte", e); }
}

function resolveSourceActor(data) {
  if (data?.sceneId && data?.tokenId) {
    const a = game.scenes.get(data.sceneId)?.tokens?.get(data.tokenId)?.actor;
    if (a) return a;
  }
  if (data?.tokenId) {
    const a = canvas.tokens?.get(data.tokenId)?.actor;
    if (a) return a;
  }
  return data?.baseActorId ? game.actors.get(data.baseActorId) ?? null : null;
}

function findRecentDamageSource(targetActor) {
  const now = Date.now(); let best = null;
  for (const owner of game.actors) {
    const data = owner.getFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE);
    if (!data) continue;
    const age = now - Number(data.time || 0);
    if (age < 0 || age > RECENT_SOURCE_MS) continue;
    const attacker = resolveSourceActor(data);
    if (!attacker) continue;
    if (!best || Number(data.time || 0) > Number(best.data.time || 0)) best = { attacker, flagOwner: owner, data };
  }
  return best;
}
async function consumeDamageSource(owner) { try { await owner?.unsetFlag(HB_FLAG_SCOPE, HB_FLAG_SOURCE); } catch (_) {} }

function resolveTokenForActor(actor, sceneId=null, tokenId=null) {
  if (sceneId && tokenId) { const d = game.scenes.get(sceneId)?.tokens?.get(tokenId); if (d) return d; }
  if (tokenId) { const o = canvas.tokens?.get(tokenId); if (o?.document) return o.document; }
  const t = (actor?.getActiveTokens?.(true, true) ?? [])[0];
  return t?.document ?? t ?? null;
}
function tokenCenterPx(t) {
  const s = canvas.grid?.size || canvas.dimensions?.size || 100;
  return { x: Number(t?.x || 0) + (Number(t?.width)||1)*s/2, y: Number(t?.y || 0) + (Number(t?.height)||1)*s/2 };
}
function distanceMetersBetween(aToken, bToken) {
  if (!aToken || !bToken) return null;
  if (aToken.parent?.id && bToken.parent?.id && aToken.parent.id !== bToken.parent.id) return null;
  const a=tokenCenterPx(aToken), b=tokenCenterPx(bToken);
  const s=canvas.grid?.size || canvas.dimensions?.size || 100;
  const gd=Number(canvas.scene?.grid?.distance ?? canvas.dimensions?.distance ?? 1)||1;
  return (Math.hypot(a.x-b.x,a.y-b.y)/s)*gd;
}

async function chooseCrimsonType(actor) {
  const old = actor.getFlag(HB_FLAG_SCOPE, CP_FLAG_TYPE);
  if (old === "fire" || old === "acid") return old;
  return await new Promise(resolve => new Dialog({
    title:"Crimson Punishment",
    content:`<p>Escolha o tipo de dano do <b>Crimson Punishment</b> para ${actor.name}:</p>`,
    buttons:{
      fire:{icon:'<i class="fas fa-fire"></i>',label:"Fogo",callback:async()=>{await actor.setFlag(HB_FLAG_SCOPE,CP_FLAG_TYPE,"fire");resolve("fire");}},
      acid:{icon:'<i class="fas fa-flask"></i>',label:"Ácido",callback:async()=>{await actor.setFlag(HB_FLAG_SCOPE,CP_FLAG_TYPE,"acid");resolve("acid");}}
    }, default:"fire", close:()=>resolve(null)
  }).render(true));
}

async function crimsonPunishment(attacker, target, data) {
  const at=resolveTokenForActor(attacker,data?.sceneId,data?.tokenId), tt=resolveTokenForActor(target);
  const distance=distanceMetersBetween(at,tt);
  if (distance === null || distance > CRIMSON_RANGE_METERS) return;
  const type=await chooseCrimsonType(target); if(!type) return;
  const roll=await new Roll("4d8").evaluate();
  const dealt=await changeHP(attacker,-roll.total);
  const label=type === "fire" ? "Fogo" : "Ácido";
  await roll.toMessage({speaker:ChatMessage.getSpeaker({actor:target}),flavor:`<b>Crimson Punishment</b><br>${attacker.name} causou dano a ${target.name} a <b>${distance.toFixed(2)} m</b>.<br>Retaliação de <b>${label}</b>: <b>4d8 = ${roll.total}</b>.<br>Dano efetivo: <b>${dealt} PV</b>.`});
}

async function normalHealingBlood(attacker,target,damage) {
  const dice=Math.floor(Math.max(0,Number(damage)||0)/7); if(dice<=0)return;
  const roll=await new Roll(`${dice}d4`).evaluate(); const healed=await changeHP(attacker,roll.total);
  await roll.toMessage({speaker:ChatMessage.getSpeaker({actor:attacker}),flavor:`<b>Healing Blood</b><br><b>${attacker.name}</b> fez ${target.name} perder <b>${damage} PV</b>.<br>Healing Blood: <b>${dice}d4 = ${roll.total}</b><br>Cura efetiva: <b>${healed} PV</b>.`});
}

Hooks.once("ready",()=>{
  if(globalThis.HealingBloodAutomation?.active)return;
  const chatHook=Hooks.on("createChatMessage",rememberChatDamageSource);
  const actorDamageHook=Hooks.on("dnd5e.damageActor",async(actor,changes={})=>{
    if(!game.user.isGM||!actor||!hasHealingBlood(actor))return;
    let amount=Math.abs(Number(changes?.total)||0);
    if(amount<=0){const h=Math.min(0,Number(changes?.hp)||0),t=Math.min(0,Number(changes?.temp)||0);amount=Math.abs(h+t);}
    if(amount<=0)return;
    await accumulateDamage(actor,amount);
    const source=findRecentDamageSource(actor);
    if(source?.attacker){
      if(hasCrimsonPunishment(actor)) await crimsonPunishment(source.attacker,actor,source.data);
      else await normalHealingBlood(source.attacker,actor,amount);
      await consumeDamageSource(source.flagOwner);
    }
  });
  const combatHook=Hooks.on("updateCombat",async(combat,changed)=>{
    if(!game.user.isGM)return;
    if(!Object.prototype.hasOwnProperty.call(changed,"turn")&&!Object.prototype.hasOwnProperty.call(changed,"round"))return;
    const done=new Set();
    for(const c of combat.combatants){const actor=c.actor;if(!actor||done.has(actor.uuid))continue;done.add(actor.uuid);if(!hasHealingBlood(actor))continue;
      const damage=Number(actor.getFlag(HB_FLAG_SCOPE,HB_FLAG_DAMAGE))||0;if(damage<=0)continue;
      const dex=Number(foundry.utils.getProperty(actor,"system.abilities.dex.mod"))||0,half=Math.floor(damage/2),heal=Math.max(0,half+dex),effective=await changeHP(actor,heal);await clearDamage(actor);
      await ChatMessage.create({speaker:ChatMessage.getSpeaker({actor}),content:`<div class="chat-card"><h2>Healing Blood</h2><p><b>${actor.name}</b> sofreu <b>${damage} de dano</b> durante o turno.</p><p>Metade: <b>${half}</b><br>Mod. Agilidade: <b>${dex>=0?"+":""}${dex}</b></p><hr><p>Recupera <b>${effective} PV</b>.</p></div>`});
    }
  });
  const effectCreateHook=Hooks.on("createActiveEffect",async e=>{if(!game.user.isGM)return;const a=e.parent;if(a&&e.name?.toLowerCase()===CP_EFFECT_NAME.toLowerCase()&&!e.disabled)await chooseCrimsonType(a);});
  const effectUpdateHook=Hooks.on("updateActiveEffect",async(e,ch)=>{if(!game.user.isGM)return;const a=e.parent;if(!a)return;if(e.name?.toLowerCase()===HB_EFFECT_NAME.toLowerCase()&&ch.disabled===true)await clearDamage(a);if(e.name?.toLowerCase()===CP_EFFECT_NAME.toLowerCase()){if(ch.disabled===false)await chooseCrimsonType(a);if(ch.disabled===true)try{await a.unsetFlag(HB_FLAG_SCOPE,CP_FLAG_TYPE);}catch(_){}}});
  const effectDeleteHook=Hooks.on("deleteActiveEffect",async e=>{if(!game.user.isGM)return;const a=e.parent;if(!a)return;if(e.name?.toLowerCase()===HB_EFFECT_NAME.toLowerCase())await clearDamage(a);if(e.name?.toLowerCase()===CP_EFFECT_NAME.toLowerCase())try{await a.unsetFlag(HB_FLAG_SCOPE,CP_FLAG_TYPE);}catch(_){}});
  globalThis.HealingBloodAutomation={active:true,version:"1.1.0",chatHook,actorDamageHook,combatHook,effectCreateHook,effectUpdateHook,effectDeleteHook};
  ui.notifications.info("Healing Blood Automation v1.1.0 carregada.");
});
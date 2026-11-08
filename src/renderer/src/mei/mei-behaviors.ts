/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Comportamentos extras da Mei ("corpo vivo"):
 * - olha para o cursor do mouse
 * - fica tonta se o mouse for sacudido em cima dela
 * - acoes por comando: andar, sentar, deitar, levantar (chamadas via tags [walk], [sit], [lie], [stand])
 * - tedio: depois de um tempo sem conversa ela senta e reclama; depois deita e cochila
 * - passeio: no modo pet, as vezes anda um pouco pela tela
 */
import { useEffect, useRef } from 'react';
import { useAiState, AiStateEnum } from '@/context/ai-state-context';
import { useMode } from '@/context/mode-context';
import { wsService } from '@/services/websocket-service';

const CFG = {
  tedioSentarMin: 4, // minutos calado ate ela sentar e reclamar
  tedioDeitarMin: 10, // minutos calado ate ela deitar e cochilar
  passeioMinSeg: 120, // intervalo minimo entre passeios (modo pet)
  passeioMaxSeg: 300,
  tontaCooldownSeg: 60,
};

const adapter = (): any => (window as any).getLAppAdapter?.();
const manager = (): any => (window as any).getLive2DManager?.();
const model = (): any => manager()?.getModel?.(0);

type Pose = 'em_pe' | 'sentada' | 'deitada';
const estado = {
  pose: 'em_pe' as Pose,
  base: null as null | { x: number; y: number; s: number },
  andando: false,
};

function matriz(): number[] | null {
  const m = model();
  return m?._modelMatrix ? [...m._modelMatrix.getArray()] : null;
}
function aplicar(mat: number[]) {
  model()?._modelMatrix?.setMatrix(mat);
}
function guardarBase() {
  const m = matriz();
  if (m && estado.pose === 'em_pe') estado.base = { x: m[12], y: m[13], s: Math.hypot(m[0], m[1]) || 1 };
}
function montar(x: number, y: number, graus: number) {
  const b = estado.base;
  const m = matriz();
  if (!b || !m) return;
  const r = (graus * Math.PI) / 180;
  m[0] = Math.cos(r) * b.s; m[1] = Math.sin(r) * b.s;
  m[4] = -Math.sin(r) * b.s; m[5] = Math.cos(r) * b.s;
  m[12] = x; m[13] = y;
  aplicar(m);
}
function animar(de: number[], para: number[], ms: number, passo: (v: number[]) => void) {
  return new Promise<void>((ok) => {
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      passo(de.map((d, i) => d + (para[i] - d) * e));
      if (k < 1) requestAnimationFrame(tick); else ok();
    };
    requestAnimationFrame(tick);
  });
}
function motion(grupo: string) {
  try { model()?.startRandomMotion?.(grupo, 3); } catch (e) { console.warn('[Mei] motion', grupo, e); }
}
function expressao(nome: string) {
  try { adapter()?.setExpression?.(nome); } catch { /* sem expressao */ }
}

export async function meiAcao(acao: string) {
  if (!model()) return;
  if (estado.pose === 'em_pe') guardarBase();
  const b = estado.base; const m = matriz();
  if (!b || !m) return;
  const atual = [m[12], m[13], (Math.atan2(m[1], m[0]) * 180) / Math.PI];
  switch (acao) {
    case 'sentar':
      estado.pose = 'sentada';
      await animar(atual, [b.x, b.y - 0.55 * b.s, 0], 900, (v) => montar(v[0], v[1], v[2]));
      break;
    case 'deitar':
      estado.pose = 'deitada';
      await animar(atual, [b.x, b.y - 0.75 * b.s, 85], 1400, (v) => montar(v[0], v[1], v[2]));
      expressao('sad');
      break;
    case 'levantar':
      if (estado.pose === 'em_pe') return;
      estado.pose = 'em_pe';
      await animar(atual, [atual[0], b.y, 0], 700, (v) => montar(v[0], v[1], v[2]));
      motion('Jump');
      break;
    case 'andar': {
      if (estado.andando) return;
      if (estado.pose !== 'em_pe') await meiAcao('levantar');
      estado.andando = true;
      const alvo = Math.max(-1.2, Math.min(1.2, atual[0] + (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.6)));
      motion('Walk');
      await animar([atual[0]], [alvo], 3500, (v) => montar(v[0], b.y, 0));
      estado.base = { ...b, x: alvo };
      motion('Idle');
      estado.andando = false;
      break;
    }
    default:
      break;
  }
}

function falarEvento(texto: string) {
  // manda um "acontecimento" para a IA reagir falando (nao aparece como fala do Eri)
  wsService.sendMessage({ type: 'text-input', text: `(acontecimento, não foi o Eri que falou: ${texto})`, images: [] });
}

export function useMeiBehaviors() {
  const { aiState } = useAiState();
  const { mode } = useMode();
  const ultimaAtividade = useRef(Date.now());
  const fase = useRef<0 | 1 | 2>(0);
  const aiRef = useRef(aiState);
  aiRef.current = aiState;

  // 1) olhar o cursor + 2) ficar tonta
  useEffect(() => {
    let ultimoX = 0; let dirAnt = 0; const viradas: number[] = []; let tontaAte = 0;
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth; const h = window.innerHeight;
      const nx = (e.clientX / w) * 2 - 1; const ny = -((e.clientY / h) * 2 - 1);
      if (!estado.andando) manager()?.onDrag?.(Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny)));
      const dx = e.clientX - ultimoX; ultimoX = e.clientX;
      if (Math.abs(dx) < 8) return;
      const dir = Math.sign(dx);
      if (dir !== dirAnt) { viradas.push(performance.now()); dirAnt = dir; }
      const agora = performance.now();
      while (viradas.length && agora - viradas[0] > 1500) viradas.shift();
      const perto = Math.abs(nx - (estado.base?.x ?? 0)) < 0.5;
      if (viradas.length >= 8 && perto && Date.now() > tontaAte && aiRef.current === AiStateEnum.IDLE) {
        tontaAte = Date.now() + CFG.tontaCooldownSeg * 1000; viradas.length = 0;
        expressao('confused');
        falarEvento('o Eri sacudiu o mouse em cima de você e você ficou tonta. Reclame em uma frase curta, do seu jeito marrento.');
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // 3) tedio (senta, reclama, deita) — zera quando ha conversa
  useEffect(() => {
    if (aiState !== AiStateEnum.IDLE) {
      ultimaAtividade.current = Date.now();
      if (fase.current > 0) { fase.current = 0; meiAcao('levantar'); }
    }
  }, [aiState]);
  useEffect(() => {
    const id = setInterval(() => {
      if (aiRef.current !== AiStateEnum.IDLE || estado.andando) return;
      const min = (Date.now() - ultimaAtividade.current) / 60000;
      if (fase.current === 0 && min >= CFG.tedioSentarMin) {
        fase.current = 1; meiAcao('sentar');
        falarEvento(`o Eri está quieto há ${Math.round(min)} minutos. Você sentou de tédio. Fale algo curto e marrento sobre estar entediada.`);
        ultimaAtividade.current = Date.now() - CFG.tedioSentarMin * 60000; // a propria fala nao reinicia o relogio do tedio
      } else if (fase.current === 1 && min >= CFG.tedioDeitarMin) {
        fase.current = 2; meiAcao('deitar');
      }
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // 4) passeio pela tela (so no modo pet, so quando parada e em pe)
  useEffect(() => {
    if (mode !== 'pet') return undefined;
    let t: any;
    const agendar = () => {
      const seg = CFG.passeioMinSeg + Math.random() * (CFG.passeioMaxSeg - CFG.passeioMinSeg);
      t = setTimeout(async () => {
        if (aiRef.current === AiStateEnum.IDLE && estado.pose === 'em_pe') await meiAcao('andar');
        agendar();
      }, seg * 1000);
    };
    agendar();
    return () => clearTimeout(t);
  }, [mode]);

  // 5) danca uns segundos quando comeca uma musica (tocada por ela ou pelo Eri)
  useEffect(() => {
    const ipc = (window as any).electron?.ipcRenderer;
    if (!ipc) return undefined;
    let ultimaDanca = 0;
    const onMusica = async () => {
      if (Date.now() - ultimaDanca < 20000) return; // no maximo uma danca a cada 20 s
      ultimaDanca = Date.now();
      if (estado.pose !== 'em_pe') await meiAcao('levantar');
      expressao('excited');
      motion('Dance');
      setTimeout(() => motion('Idle'), 7000);
    };
    ipc.on('mei-musica', onMusica);
    return () => ipc.removeListener?.('mei-musica', onMusica);
  }, []);

  // acesso pelo console para testes: meiAcao('sentar')
  useEffect(() => { (window as any).meiAcao = meiAcao; }, []);
}

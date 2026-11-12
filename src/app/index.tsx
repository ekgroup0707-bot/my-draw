import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import Svg, { Path } from "react-native-svg";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useAudioPlayer } from "expo-audio";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";

type PenId = "pen" | "pencil" | "marker" | "highlighter";
type IconName = keyof typeof MaterialCommunityIcons.glyphMap;
type Stroke = { d: string; color: string; width: number; opacity: number; cap: "round" | "butt" };

// ===== 調整したいときはここを触る =====
const SPEED_FOR_MAX = 0.6; // この速さ(px/ms)で最大音量。小さくすると鳴りやすい
const SILENCE_MS = 90; // 手が止まってから音が消えるまで(ミリ秒)
const SOUND_LEVELS: { label: string; v: number; icon: IconName }[] = [
  { label: "オフ", v: 0, icon: "volume-off" },
  { label: "小", v: 0.35, icon: "volume-low" },
  { label: "中", v: 0.8, icon: "volume-medium" },
  { label: "大", v: 1, icon: "volume-high" },
];
// ======================================

const STYLUS = 1; // pointerType: 0=指, 1=ペン
const PAPER = "#fffdf7";
const COLORS = ["#222222", "#e53935", "#1e88e5", "#43a047", "#fb8c00", "#8e24aa"];
const WIDTHS = [2, 4, 8, 14];
const NOTEBOOK_KEY = "my-draw:notebook:v1";
const OLD_KEY = "my-draw:strokes";

const PENS: Record<
  PenId,
  {
    label: string;
    icon: IconName;
    widthScale: number;
    opacity: number;
    cap: "round" | "butt";
    sound: number; // 音の大きさの倍率
    rate: number; // 音の高さ・速さ
  }
> = {
  pen: { label: "ペン", icon: "pen", widthScale: 1, opacity: 1, cap: "round", sound: 0.6, rate: 1.15 },
  pencil: { label: "鉛筆", icon: "lead-pencil", widthScale: 0.8, opacity: 0.75, cap: "round", sound: 1, rate: 1 },
  marker: { label: "マーカー", icon: "marker", widthScale: 2.2, opacity: 0.9, cap: "round", sound: 0.5, rate: 0.8 },
  highlighter: { label: "蛍光ペン", icon: "format-color-highlight", widthScale: 4, opacity: 0.35, cap: "butt", sound: 0.3, rate: 0.7 },
};

function ToolButton({
  icon,
  label,
  active,
  onPress,
}: {
  icon: IconName;
  label?: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.tool, active && styles.toolActive]}>
      <MaterialCommunityIcons name={icon} size={24} color={active ? "#1565c0" : "#444"} />
      {label ? <Text style={[styles.toolLabel, active && { color: "#1565c0" }]}>{label}</Text> : null}
    </Pressable>
  );
}

export default function Index() {
  const [pages, setPages] = useState<Stroke[][]>([[]]);
  const [pageIndex, setPageIndex] = useState(0);
  const [current, setCurrent] = useState<Stroke | null>(null);
  const [eraser, setEraser] = useState(false);
  const [pen, setPen] = useState<PenId>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [soundIdx, setSoundIdx] = useState(2); // 0=オフ 1=小 2=中 3=大
  const [loaded, setLoaded] = useState(false);

  const strokes = pages[pageIndex] ?? [];
  const canvasRef = useRef<View>(null);

  // ---- 音 ----
  const player = useAudioPlayer(require("../../assets/sounds/pencil.wav"));
  const playerRef = useRef(player);
  playerRef.current = player;
  useEffect(() => {
    try {
      player.loop = true;
      player.volume = 0;
    } catch {}
  }, [player]);

  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const motion = useRef({ x: 0, y: 0, t: 0, isPencil: false, factor: 1, rate: 1, vol: 0 });

  const setVolume = (v: number) => {
    try {
      playerRef.current.volume = Math.max(0, Math.min(1, v));
    } catch {}
  };
  const stopSound = () => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    try {
      playerRef.current.pause();
      playerRef.current.volume = 0;
    } catch {}
    motion.current.isPencil = false;
    motion.current.vol = 0;
  };
  const markPencil = () => {
    if (settings.current.soundVol <= 0 || motion.current.isPencil) return;
    motion.current.isPencil = true;
    try {
      playerRef.current.volume = 0;
      playerRef.current.setPlaybackRate(motion.current.rate);
    } catch {}
    try {
      playerRef.current.play();
    } catch {}
  };

  // ---- 保存と読み込み ----
  useEffect(() => {
    (async () => {
      try {
        const nb = await AsyncStorage.getItem(NOTEBOOK_KEY);
        if (nb) {
          const d = JSON.parse(nb);
          if (Array.isArray(d.pages) && d.pages.length > 0) {
            setPages(d.pages);
            setPageIndex(Math.min(d.index ?? 0, d.pages.length - 1));
          }
        } else {
          // 前のバージョンで描いた絵を1ページ目として引き継ぐ
          const old = await AsyncStorage.getItem(OLD_KEY);
          if (old) setPages([JSON.parse(old)]);
        }
      } catch (e) {
        console.warn("読み込みに失敗", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(NOTEBOOK_KEY, JSON.stringify({ pages, index: pageIndex })).catch((e) =>
      console.warn("保存に失敗", e)
    );
  }, [pages, pageIndex, loaded]);

  // ---- 描く ----
  const settings = useRef({ eraser, color, width, pen, soundVol: SOUND_LEVELS[soundIdx].v });
  settings.current = { eraser, color, width, pen, soundVol: SOUND_LEVELS[soundIdx].v };
  const currentRef = useRef<Stroke | null>(null);
  const pageRef = useRef(0);
  pageRef.current = pageIndex;

  const finishStroke = () => {
    const stroke = currentRef.current;
    if (stroke) {
      const i = pageRef.current;
      setPages((prev) => prev.map((p, idx) => (idx === i ? [...p, stroke] : p)));
    }
    currentRef.current = null;
    setCurrent(null);
    stopSound();
  };

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .maxPointers(1)
        .onBegin((e: any) => {
          const { x, y } = e;
          const s = settings.current;
          const p = PENS[s.pen];
          const stroke: Stroke = s.eraser
            ? { d: `M${x},${y} L${x},${y}`, color: PAPER, width: 28, opacity: 1, cap: "round" }
            : {
                d: `M${x},${y} L${x},${y}`,
                color: s.color,
                width: s.width * p.widthScale,
                opacity: p.opacity,
                cap: p.cap,
              };
          currentRef.current = stroke;
          setCurrent(stroke);
          motion.current = {
            x,
            y,
            t: Date.now(),
            isPencil: false,
            factor: s.eraser ? 0.5 : p.sound,
            rate: s.eraser ? 0.9 : p.rate,
            vol: 0,
          };
          if (e.pointerType === STYLUS) markPencil();
        })
        .onUpdate((e: any) => {
          if (!currentRef.current) return;
          const { x, y } = e;
          if (e.pointerType === STYLUS) markPencil();

          const stroke = { ...currentRef.current, d: currentRef.current.d + ` L${x},${y}` };
          currentRef.current = stroke;
          setCurrent(stroke);

          // 速く動かすほど音が大きく、止まると消える
          const m = motion.current;
          const now = Date.now();
          const dt = Math.max(1, now - m.t);
          const speed = Math.hypot(x - m.x, y - m.y) / dt;
          m.x = x;
          m.y = y;
          m.t = now;
          if (m.isPencil) {
            const target = Math.min(1, speed / SPEED_FOR_MAX) * settings.current.soundVol * m.factor;
            m.vol = m.vol * 0.6 + target * 0.4;
            setVolume(m.vol);
            if (silenceTimer.current) clearTimeout(silenceTimer.current);
            silenceTimer.current = setTimeout(() => {
              m.vol = 0;
              setVolume(0);
            }, SILENCE_MS);
          }
        })
        .onFinalize(() => {
          finishStroke();
        }),
    []
  );

  // ---- 操作 ----
  const undo = () => setPages((prev) => prev.map((p, i) => (i === pageIndex ? p.slice(0, -1) : p)));

  const confirmClear = () =>
    Alert.alert("このページを全部消す?", "描いた絵が消えます", [
      { text: "やめる", style: "cancel" },
      {
        text: "消す",
        style: "destructive",
        onPress: () => setPages((prev) => prev.map((p, i) => (i === pageIndex ? [] : p))),
      },
    ]);

  const addPage = () => {
    setPages((prev) => [...prev, []]);
    setPageIndex(pages.length);
  };

  const confirmDeletePage = () => {
    if (pages.length <= 1) {
      Alert.alert("最後の1ページは削除できません", "「全消し」で白紙に戻せます");
      return;
    }
    Alert.alert("このページを削除する?", `${pageIndex + 1}ページ目が消えます`, [
      { text: "やめる", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: () => {
          setPages((prev) => prev.filter((_, i) => i !== pageIndex));
          setPageIndex(Math.max(0, pageIndex - 1));
        },
      },
    ]);
  };

  const exportImage = async () => {
    try {
      const uri = await captureRef(canvasRef, { format: "png", quality: 1 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "image/png", UTI: "public.png" });
      } else {
        Alert.alert("この端末では共有できません");
      }
    } catch (e) {
      Alert.alert("書き出しに失敗しました", String(e));
    }
  };

  const preview = () => {
    try {
      player.volume = Math.max(0.2, SOUND_LEVELS[soundIdx].v);
      player.play();
      setTimeout(() => player.pause(), 1500);
    } catch {}
  };

  const level = SOUND_LEVELS[soundIdx];

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.container}>
        <View style={styles.card}>
          <View style={styles.row}>
            {(Object.keys(PENS) as PenId[]).map((id) => (
              <ToolButton
                key={id}
                icon={PENS[id].icon}
                label={PENS[id].label}
                active={!eraser && pen === id}
                onPress={() => {
                  setPen(id);
                  setEraser(false);
                }}
              />
            ))}
            <ToolButton icon="eraser" label="消しゴム" active={eraser} onPress={() => setEraser(true)} />
            <View style={{ flex: 1 }} />
            <ToolButton
              icon={level.icon}
              label={`音:${level.label}`}
              active={level.v > 0}
              onPress={() => setSoundIdx((i) => (i + 1) % SOUND_LEVELS.length)}
            />
            <ToolButton icon="play-circle-outline" label="試聴" onPress={preview} />
            <ToolButton icon="undo" label="戻す" onPress={undo} />
            <ToolButton icon="trash-can-outline" label="全消し" onPress={confirmClear} />
            <ToolButton icon="export-variant" label="画像" onPress={exportImage} />
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            {COLORS.map((c) => (
              <Pressable
                key={c}
                onPress={() => {
                  setColor(c);
                  setEraser(false);
                }}
                style={[styles.colorDot, { backgroundColor: c }, !eraser && color === c && styles.colorSelected]}
              />
            ))}
            <View style={{ width: 20 }} />
            {WIDTHS.map((w) => (
              <Pressable
                key={w}
                onPress={() => {
                  setWidth(w);
                  setEraser(false);
                }}
                style={[styles.widthBtn, !eraser && width === w && styles.toolActive]}
              >
                <View style={{ width: w + 2, height: w + 2, borderRadius: w, backgroundColor: "#333" }} />
              </Pressable>
            ))}
          </View>
        </View>

        <GestureDetector gesture={gesture}>
          <View style={styles.canvasFrame}>
            <View ref={canvasRef} collapsable={false} style={styles.canvasInner}>
              <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
                {[...strokes, ...(current ? [current] : [])].map((s, i) => (
                  <Path
                    key={i}
                    d={s.d}
                    stroke={s.color}
                    strokeWidth={s.width}
                    strokeOpacity={s.opacity ?? 1}
                    strokeLinecap={s.cap ?? "round"}
                    strokeLinejoin="round"
                    fill="none"
                  />
                ))}
              </Svg>
            </View>
          </View>
        </GestureDetector>

        <View style={[styles.card, styles.pageBar]}>
          <ToolButton icon="chevron-left" onPress={() => setPageIndex((i) => Math.max(0, i - 1))} />
          <Text style={styles.pageText}>
            {pageIndex + 1} / {pages.length}
          </Text>
          <ToolButton
            icon="chevron-right"
            onPress={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}
          />
          <View style={{ flex: 1 }} />
          <ToolButton icon="file-plus-outline" label="ページ追加" onPress={addPage} />
          <ToolButton icon="file-remove-outline" label="ページ削除" onPress={confirmDeletePage} />
        </View>
      </View>
    </GestureHandlerRootView>
  );
}

const shadow = {
  shadowColor: "#000",
  shadowOpacity: 0.12,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
  elevation: 4,
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#e6e1d6", paddingTop: 50, paddingHorizontal: 14, paddingBottom: 14 },
  card: { backgroundColor: "#ffffff", borderRadius: 18, padding: 10, marginBottom: 12, ...shadow },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  divider: { height: 1, backgroundColor: "#eee", marginVertical: 8 },
  tool: {
    minWidth: 64,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "#f4f4f4",
  },
  toolActive: { backgroundColor: "#d6eaff" },
  toolLabel: { fontSize: 11, marginTop: 2, color: "#444" },
  colorDot: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: "#ddd" },
  colorSelected: { borderColor: "#111", borderWidth: 3 },
  widthBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "#f4f4f4",
    alignItems: "center",
    justifyContent: "center",
  },
  canvasFrame: { flex: 1, borderRadius: 18, overflow: "hidden", marginBottom: 12, ...shadow },
  canvasInner: { flex: 1, backgroundColor: PAPER },
  pageBar: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 0 },
  pageText: { fontSize: 16, fontWeight: "600", color: "#333", minWidth: 56, textAlign: "center" },
});

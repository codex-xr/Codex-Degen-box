import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { ChainKey, CHAINS } from "../chains/registry.js";
import { PnlTheme } from "../db/userVault.js";
import { formatDuration, formatExactUnits, formatUsd } from "../utils/amounts.js";

const require = createRequire(import.meta.url);

export interface PnlCardInput {
  theme: PnlTheme;
  chain: ChainKey;
  tokenSymbol: string;
  sourceLabel: string; // e.g., "MANUAL" or "COPIED: AlphaWhale"
  roiPct: number;
  pnlNativeAtomic: bigint;
  pnlUsd: number;
  investedNativeAtomic: bigint;
  entryMcUsd: number;
  currentOrExitMcUsd: number;
  holdDurationMs: number;
  statusLabel: string; // "OPEN" | "CLOSED" | "RUGGED"
  traderHandle?: string;
}

interface ThemePalette {
  bg: string;
  panel: string;
  border: string;
  accent: string;
  badgeBg: string;
}

const PALETTES: Record<PnlTheme, ThemePalette> = {
  cyber: {
    bg: "linear-gradient(135deg, #070B14 0%, #0E1729 55%, #091322 100%)",
    panel: "rgba(255, 255, 255, 0.04)",
    border: "rgba(255, 255, 255, 0.12)",
    accent: "#38BDF8",
    badgeBg: "rgba(56, 189, 248, 0.14)"
  },
  solana: {
    bg: "linear-gradient(135deg, #0B0718 0%, #190F33 55%, #0B192C 100%)",
    panel: "rgba(153, 69, 255, 0.08)",
    border: "rgba(20, 241, 149, 0.25)",
    accent: "#14F195",
    badgeBg: "rgba(153, 69, 255, 0.22)"
  },
  robinhood: {
    bg: "linear-gradient(135deg, #04130A 0%, #072613 60%, #05160E 100%)",
    panel: "rgba(0, 200, 5, 0.07)",
    border: "rgba(0, 200, 5, 0.28)",
    accent: "#00C805",
    badgeBg: "rgba(0, 200, 5, 0.18)"
  },
  gold: {
    bg: "linear-gradient(135deg, #120E06 0%, #241A09 55%, #110C05 100%)",
    panel: "rgba(245, 158, 11, 0.08)",
    border: "rgba(251, 191, 36, 0.28)",
    accent: "#FBBF24",
    badgeBg: "rgba(251, 191, 36, 0.18)"
  }
};

type FontConfig = {
  name: string;
  data: Buffer;
  weight: 400 | 600 | 700;
  style: "normal";
};

export class PnlCardRenderer {
  private fonts: FontConfig[] | null = null;

  private loadFonts(): FontConfig[] {
    if (this.fonts) return this.fonts;

    const sgDir = path.dirname(require.resolve("@fontsource/space-grotesk/package.json"));
    const interDir = path.dirname(require.resolve("@fontsource/inter/package.json"));

    const sg500 = fs.readFileSync(path.join(sgDir, "files", "space-grotesk-latin-500-normal.woff"));
    const sg700 = fs.readFileSync(path.join(sgDir, "files", "space-grotesk-latin-700-normal.woff"));
    const inter400 = fs.readFileSync(path.join(interDir, "files", "inter-latin-400-normal.woff"));
    const inter600 = fs.readFileSync(path.join(interDir, "files", "inter-latin-600-normal.woff"));

    this.fonts = [
      { name: "Space Grotesk", data: sg500, weight: 400, style: "normal" },
      { name: "Space Grotesk", data: sg700, weight: 700, style: "normal" },
      { name: "Inter", data: inter400, weight: 400, style: "normal" },
      { name: "Inter", data: inter600, weight: 600, style: "normal" }
    ];
    return this.fonts;
  }

  async renderPng(input: PnlCardInput): Promise<Buffer> {
    const palette = PALETTES[input.theme] ?? PALETTES.cyber;
    const spec = CHAINS[input.chain];
    const isWin = input.roiPct >= 0;
    const pnlColor = input.statusLabel === "RUGGED" ? "#EF4444" : isWin ? "#22C55E" : "#F43F5E";
    const glowBg = isWin
      ? "radial-gradient(circle at 85% 25%, rgba(34, 197, 94, 0.22), transparent 55%)"
      : "radial-gradient(circle at 85% 25%, rgba(244, 63, 94, 0.22), transparent 55%)";

    const roiText = `${input.roiPct >= 0 ? "+" : ""}${input.roiPct.toFixed(1)}%`;
    const pnlNativeText = `${input.pnlNativeAtomic >= 0n ? "+" : ""}${formatExactUnits(
      input.pnlNativeAtomic,
      spec.nativeDecimals,
      6
    )} ${spec.nativeSymbol}`;
    const pnlUsdText = `${input.pnlUsd >= 0 ? "+" : ""}${formatUsd(input.pnlUsd)}`;
    const investedText = `${formatExactUnits(
      input.investedNativeAtomic,
      spec.nativeDecimals,
      6
    )} ${spec.nativeSymbol}`;

    const element = {
      type: "div",
      props: {
        style: {
          width: "1200px",
          height: "675px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "40px 48px",
          backgroundImage: `${glowBg}, ${palette.bg}`,
          color: "#F8FAFC",
          fontFamily: "Inter"
        },
        children: [
          // Top Header Row
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center"
              },
              children: [
                {
                  type: "div",
                  props: {
                    style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "14px" },
                    children: [
                      {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            fontSize: "24px",
                            fontWeight: 700,
                            fontFamily: "Space Grotesk",
                            letterSpacing: "1.5px",
                            color: "#FFFFFF"
                          },
                          children: "CODEX DEGEN BOX"
                        }
                      },
                      {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            padding: "6px 14px",
                            borderRadius: "999px",
                            background: palette.badgeBg,
                            border: `1px solid ${palette.border}`,
                            fontSize: "16px",
                            fontWeight: 600,
                            color: palette.accent
                          },
                          children: `${spec.name.toUpperCase()}`
                        }
                      }
                    ]
                  }
                },
                {
                  type: "div",
                  props: {
                    style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" },
                    children: [
                      {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            padding: "6px 14px",
                            borderRadius: "8px",
                            background: "rgba(255,255,255,0.06)",
                            border: `1px solid ${palette.border}`,
                            fontSize: "15px",
                            fontWeight: 600,
                            color: "#CBD5E1"
                          },
                          children: input.sourceLabel.toUpperCase()
                        }
                      },
                      {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            padding: "6px 14px",
                            borderRadius: "8px",
                            background:
                              input.statusLabel === "RUGGED"
                                ? "rgba(239,68,68,0.22)"
                                : "rgba(255,255,255,0.08)",
                            fontSize: "15px",
                            fontWeight: 700,
                            color: input.statusLabel === "RUGGED" ? "#FCA5A5" : "#E2E8F0"
                          },
                          children: `DEMO • ${input.statusLabel}`
                        }
                      }
                    ]
                  }
                }
              ]
            }
          },

          // Center Hero Block
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                marginTop: "6px"
              },
              children: [
                {
                  type: "div",
                  props: {
                    style: {
                      display: "flex",
                      fontSize: "38px",
                      fontWeight: 700,
                      fontFamily: "Space Grotesk",
                      color: "#E2E8F0"
                    },
                    children: `$${input.tokenSymbol.replace(/^\$/, "")}`
                  }
                },
                {
                  type: "div",
                  props: {
                    style: {
                      display: "flex",
                      fontSize: "104px",
                      lineHeight: 1.0,
                      fontWeight: 700,
                      fontFamily: "Space Grotesk",
                      color: pnlColor
                    },
                    children: roiText
                  }
                },
                {
                  type: "div",
                  props: {
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "center",
                      gap: "18px",
                      marginTop: "6px"
                    },
                    children: [
                      {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            fontSize: "34px",
                            fontWeight: 700,
                            fontFamily: "Space Grotesk",
                            color: "#FFFFFF"
                          },
                          children: pnlNativeText
                        }
                      },
                      {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            fontSize: "28px",
                            fontWeight: 600,
                            color: "#94A3B8"
                          },
                          children: `(${pnlUsdText})`
                        }
                      }
                    ]
                  }
                }
              ]
            }
          },

          // Bottom Stats Grid (Flexbox)
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: "16px"
              },
              children: [
                {
                  type: "div",
                  props: {
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      gap: "16px"
                    },
                    children: [
                      this.statBox("INVESTED", investedText, palette),
                      this.statBox("ENTRY MC", formatUsd(input.entryMcUsd), palette),
                      this.statBox(
                        input.statusLabel === "OPEN" ? "CURRENT MC" : "EXIT MC",
                        formatUsd(input.currentOrExitMcUsd),
                        palette
                      ),
                      this.statBox("HOLD TIME", formatDuration(input.holdDurationMs), palette)
                    ]
                  }
                },
                {
                  type: "div",
                  props: {
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      justifyContent: "space-between",
                      fontSize: "15px",
                      color: "#64748B"
                    },
                    children: [
                      {
                        type: "div",
                        props: {
                          style: { display: "flex" },
                          children: input.traderHandle
                            ? `Trader: ${input.traderHandle}`
                            : "Private Cabal Paper Trading Lab"
                        }
                      },
                      {
                        type: "div",
                        props: {
                          style: { display: "flex" },
                          children: "Simulated against live on-chain liquidity & fees"
                        }
                      }
                    ]
                  }
                }
              ]
            }
          }
        ]
      }
    };

    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: 1200,
      height: 675,
      fonts: this.loadFonts()
    });

    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
    return Buffer.from(resvg.render().asPng());
  }

  private statBox(label: string, value: string, palette: ThemePalette) {
    return {
      type: "div",
      props: {
        style: {
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "16px 20px",
          borderRadius: "14px",
          background: palette.panel,
          border: `1px solid ${palette.border}`
        },
        children: [
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                fontSize: "13px",
                fontWeight: 600,
                letterSpacing: "1px",
                color: "#94A3B8"
              },
              children: label
            }
          },
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                fontSize: "24px",
                fontWeight: 700,
                fontFamily: "Space Grotesk",
                color: "#F8FAFC"
              },
              children: value
            }
          }
        ]
      }
    };
  }
}

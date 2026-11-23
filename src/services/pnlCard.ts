import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { ChainKey, CHAINS, shortAddress } from "../chains/registry.js";
import { PnlTheme } from "../db/userVault.js";
import { formatDuration, formatExactUnits, formatUsd } from "../utils/amounts.js";
import { WalletInvestigationReport } from "./walletDetective.js";

function asciiClean(input: string): string {
  return input.replace(/[^\x20-\x7E]/g, "").trim() || "-";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function resolvePalette(theme: PnlTheme, accentHex?: string | null, hasBg = false): ThemePalette {
  const base = PALETTES[theme] ?? PALETTES.cyber;
  const rgb = accentHex ? hexToRgb(accentHex) : null;
  const accent = rgb ? `#${accentHex!.replace(/^#/, "").toUpperCase()}` : base.accent;
  const border = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.36)` : base.border;
  const badgeBg = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)` : base.badgeBg;
  const panel = hasBg
    ? "rgba(7, 11, 20, 0.72)"
    : rgb
      ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`
      : base.panel;
  return { bg: base.bg, panel, border, accent, badgeBg };
}

const require = createRequire(import.meta.url);

export interface PnlCardInput {
  theme: PnlTheme;
  accentHex?: string | null;
  hideAmounts?: boolean;
  bgDataUrl?: string | null;
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
    const validBg =
      input.bgDataUrl && /^data:image\/(jpeg|jpg|png);base64,/i.test(input.bgDataUrl)
        ? input.bgDataUrl
        : null;
    const palette = resolvePalette(input.theme, input.accentHex, Boolean(validBg));
    const spec = CHAINS[input.chain];
    const isWin = input.roiPct >= 0;
    const pnlColor = input.statusLabel === "RUGGED" ? "#EF4444" : isWin ? "#22C55E" : "#F43F5E";
    const rgb = hexToRgb(palette.accent);
    const glowBg = rgb
      ? `radial-gradient(circle at 85% 25%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.24), transparent 55%)`
      : isWin
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

    const safeSymbol = asciiClean(input.tokenSymbol.replace(/^\$/, ""));
    const safeSource = asciiClean(input.sourceLabel).toUpperCase();
    const safeTrader = input.traderHandle ? asciiClean(input.traderHandle) : "";

    const buildElement = (bgUrl: string | null) => {
      const p = resolvePalette(input.theme, input.accentHex, Boolean(bgUrl));
      return {
        type: "div",
        props: {
          style: {
            position: "relative",
            width: "1200px",
            height: "675px",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "40px 48px",
            backgroundColor: "#070B14",
            backgroundImage: bgUrl ? undefined : `${glowBg}, ${p.bg}`,
            color: "#F8FAFC",
            fontFamily: "Inter",
            overflow: "hidden"
          },
          children: [
            ...(bgUrl
              ? [
                  {
                    type: "img",
                    props: {
                      src: bgUrl,
                      width: 1200,
                      height: 675,
                      style: {
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "1200px",
                        height: "675px",
                        objectFit: "cover"
                      }
                    }
                  },
                  {
                    type: "div",
                    props: {
                      style: {
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "1200px",
                        height: "675px",
                        display: "flex",
                        backgroundImage: `${glowBg}, linear-gradient(135deg, rgba(6,10,19,0.82) 0%, rgba(10,16,30,0.68) 55%, rgba(6,10,19,0.86) 100%)`
                      }
                    }
                  }
                ]
              : []),
            // Top Header Row
            {
              type: "div",
              props: {
                style: {
                  position: "relative",
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
                              fontSize: "26px",
                              fontWeight: 700,
                              fontFamily: "Space Grotesk",
                              letterSpacing: "1.5px",
                              color: "#FFFFFF"
                            },
                            children: "EVIL.FUN"
                          }
                        },
                        {
                          type: "div",
                          props: {
                            style: {
                              display: "flex",
                              padding: "6px 14px",
                              borderRadius: "999px",
                              background: p.badgeBg,
                              border: `1px solid ${p.border}`,
                              fontSize: "16px",
                              fontWeight: 600,
                              color: p.accent
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
                              background: "rgba(255,255,255,0.08)",
                              border: `1px solid ${p.border}`,
                              fontSize: "15px",
                              fontWeight: 600,
                              color: "#E2E8F0"
                            },
                            children: safeSource
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
                                  ? "rgba(239,68,68,0.24)"
                                  : "rgba(255,255,255,0.10)",
                              border: `1px solid ${p.border}`,
                              fontSize: "15px",
                              fontWeight: 700,
                              color: input.statusLabel === "RUGGED" ? "#FCA5A5" : p.accent
                            },
                            children: input.statusLabel
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
                  position: "relative",
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
                      children: `$${safeSymbol}`
                    }
                  },
                  {
                    type: "div",
                    props: {
                      style: {
                        display: "flex",
                        fontSize: "108px",
                        lineHeight: 1.0,
                        fontWeight: 700,
                        fontFamily: "Space Grotesk",
                        color: pnlColor
                      },
                      children: roiText
                    }
                  },
                  ...(input.hideAmounts
                    ? []
                    : [
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
                      ])
                ]
              }
            },

            // Bottom Stats Grid (Flexbox)
            {
              type: "div",
              props: {
                style: {
                  position: "relative",
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
                        ...(input.hideAmounts ? [] : [this.statBox("INVESTED", investedText, p)]),
                        this.statBox("ENTRY MC", formatUsd(input.entryMcUsd), p),
                        this.statBox(
                          input.statusLabel === "OPEN" ? "CURRENT MC" : "EXIT MC",
                          formatUsd(input.currentOrExitMcUsd),
                          p
                        ),
                        this.statBox("HOLD TIME", formatDuration(input.holdDurationMs), p)
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
                        color: "#94A3B8"
                      },
                      children: [
                        {
                          type: "div",
                          props: {
                            style: { display: "flex" },
                            children: safeTrader ? `Trader: ${safeTrader}` : "Evil.fun Trading"
                          }
                        },
                        {
                          type: "div",
                          props: {
                            style: { display: "flex", color: p.accent, fontWeight: 600 },
                            children: "Evil.fun • Live On-Chain Execution"
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
    };

    try {
      return await this.renderElementToPng(buildElement(validBg), 1200, 675);
    } catch {
      // Fallback cleanly to built-in background if a custom image buffer cannot be decoded
      return this.renderElementToPng(buildElement(null), 1200, 675);
    }
  }

  async renderDetectivePng(
    report: WalletInvestigationReport,
    theme: PnlTheme,
    alias?: string,
    accentHex?: string | null
  ): Promise<Buffer> {
    const palette = resolvePalette(theme, accentHex, false);
    const spec = CHAINS[report.chain];
    const titleLabel = asciiClean(alias ? `${alias} (${shortAddress(report.address)})` : shortAddress(report.address, 8, 6));
    const roleLabel = asciiClean(report.roleSummary).toUpperCase();
    const twitterStr =
      report.identity.twitterHandles.length > 0
        ? report.identity.twitterHandles.map((t) => `@${t}`).join(", ")
        : "None publicly linked";
    const domainStr =
      [...report.identity.domains, report.identity.pumpUsername ? `pump:${report.identity.pumpUsername}` : ""]
        .filter(Boolean)
        .map(asciiClean)
        .join(" | ") || shortAddress(report.address, 8, 6);

    const buddies = report.connectedWallets.slice(0, 4);

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
          padding: "34px 44px",
          backgroundImage: `radial-gradient(circle at 85% 20%, rgba(56, 189, 248, 0.18), transparent 55%), ${palette.bg}`,
          color: "#F8FAFC",
          fontFamily: "Inter"
        },
        children: [
          {
            type: "div",
            props: {
              style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
              children: [
                {
                  type: "div",
                  props: {
                    style: { display: "flex", alignItems: "center", gap: "12px" },
                    children: [
                      {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            fontSize: "22px",
                            fontWeight: 700,
                            fontFamily: "Space Grotesk",
                            color: "#FFFFFF"
                          },
                          children: "WALLET DETECTIVE DOSSIER"
                        }
                      },
                      {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            padding: "5px 12px",
                            borderRadius: "999px",
                            background: palette.badgeBg,
                            border: `1px solid ${palette.accent}`,
                            color: palette.accent,
                            fontSize: "13px",
                            fontWeight: 700
                          },
                          children: `${spec.shortBadge} • ${report.days}D SCAN`
                        }
                      }
                    ]
                  }
                },
                {
                  type: "div",
                  props: {
                    style: {
                      display: "flex",
                      padding: "6px 14px",
                      borderRadius: "999px",
                      background: "rgba(255,255,255,0.08)",
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#E2E8F0"
                    },
                    children: roleLabel
                  }
                }
              ]
            }
          },
          {
            type: "div",
            props: {
              style: { display: "flex", flexDirection: "column", gap: "6px" },
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
                    children: titleLabel
                  }
                },
                {
                  type: "div",
                  props: {
                    style: { display: "flex", fontSize: "16px", color: "#94A3B8" },
                    children: `X/Twitter: ${twitterStr}   |   IDs: ${domainStr}`
                  }
                }
              ]
            }
          },
          {
            type: "div",
            props: {
              style: { display: "flex", gap: "14px" },
              children: [
                this.statBox(
                  "EXISTING BALANCE",
                  `${report.nativeBalanceStr} ${report.nativeSymbol} (${formatUsd(report.totalHoldingsUsd)})`,
                  palette
                ),
                this.statBox(
                  `${report.days}D ACTIVITY`,
                  `${report.activityCount} moves (${report.swapsCount} swaps)`,
                  palette
                ),
                this.statBox(
                  "COINS LAUNCHED",
                  report.launchedCount > 0 ? `${report.launchedCount} created` : "0 found",
                  palette
                )
              ]
            }
          },
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: "8px",
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
                      fontWeight: 700,
                      letterSpacing: "1px",
                      color: palette.accent
                    },
                    children: "TOP CONNECTED WALLETS (MOST INTERACTIONS)"
                  }
                },
                ...(buddies.length === 0
                  ? [
                      {
                        type: "div",
                        props: {
                          style: { display: "flex", fontSize: "15px", color: "#94A3B8" },
                          children: "No direct wallet transfers spotted inside this window."
                        }
                      }
                    ]
                  : buddies.map((b) => {
                      const bName = asciiClean(b.label ? `${b.label} (${shortAddress(b.address)})` : shortAddress(b.address, 7, 5));
                      const dir = asciiClean(b.directionTag);
                      const bal = b.totalHoldingsUsd !== null ? formatUsd(b.totalHoldingsUsd) : "-";
                      const tw = b.identity.twitterHandles[0] ? `@${b.identity.twitterHandles[0]}` : "";
                      const coinStr = b.launchedCount > 0 ? ` • ${b.launchedCount} coins` : "";
                      return {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: "15px",
                            color: "#F1F5F9"
                          },
                          children: [
                            {
                              type: "div",
                              props: {
                                style: { display: "flex", fontWeight: 600 },
                                children: `${bName}  [${b.interactionsCount}x • ${dir}]`
                              }
                            },
                            {
                              type: "div",
                              props: {
                                style: { display: "flex", color: "#CBD5E1", fontSize: "14px" },
                                children: `${asciiClean(b.roleBadge)} • Bal ${bal}${coinStr}${tw ? ` • ${tw}` : ""}`
                              }
                            }
                          ]
                        }
                      };
                    }))
              ]
            }
          },
          {
            type: "div",
            props: {
              style: {
                display: "flex",
                justifyContent: "space-between",
                fontSize: "14px",
                color: "#94A3B8"
              },
              children: [
                {
                  type: "div",
                  props: {
                    style: { display: "flex" },
                    children: report.firstFunder
                      ? `First funder: ${asciiClean(report.firstFunder.label ?? shortAddress(report.firstFunder.address))}`
                      : `Peak hours: ${report.peakHoursUtc ?? "N/A"}`
                  }
                },
                {
                  type: "div",
                  props: {
                    style: { display: "flex" },
                    children: "Evil.fun • On-Chain Wallet Investigation"
                  }
                }
              ]
            }
          }
        ]
      }
    };

    return this.renderElementToPng(element, 1200, 675);
  }

  private async renderElementToPng(element: unknown, width: number, height: number): Promise<Buffer> {
    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width,
      height,
      fonts: this.loadFonts()
    });
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
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

import type { Metadata } from "next";
import { AgentSettingsPanel } from "@/components/agent/agent-settings";
export const metadata: Metadata = { title: "Agent 设置 · MxPage", robots: { index: false, follow: false } };
export default function AgentSettingsPage() { return <AgentSettingsPanel />; }

import type { Metadata } from "next";
import { AgentWorkspace } from "@/components/agent/agent-workspace";
export const metadata: Metadata = { title: "Agent 工作台 · MxPage", robots: { index: false, follow: false } };
export default function AgentPage() { return <AgentWorkspace />; }

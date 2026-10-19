/** @type {import('next').NextConfig} */
const distDir = process.env.NEXT_DIST_DIR || ".next";

const nextConfig = {
  output: "standalone",
  distDir,
  ...(process.env.MXPAGE_TEST_TSCONFIG ? { typescript: { tsconfigPath: process.env.MXPAGE_TEST_TSCONFIG } } : {}),
  experimental: {
    ...(distDir === ".next-desktop" ? { cpus: 2 } : {}),
    serverComponentsExternalPackages: ["sharp", "deepagents", "langchain", "langsmith", "@langchain/core", "@langchain/openai", "@langchain/langgraph", "@langchain/langgraph-checkpoint", "@modelcontextprotocol/sdk", "pdfjs-dist", "mammoth", "exceljs", "docx", "pdf-lib", "@pdf-lib/fontkit"],
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;

/**
 * Generative UI (OpenUI pattern): the model writes OpenUI Lang in a tool call,
 * the ChatView renders it as rich React components (charts, tables, forms).
 */
import { registerTool } from "./gateway.js";

/** Component names the model can use — mirrors @openuidev/react-ui openuiChatLibrary. */
const AVAILABLE_COMPONENTS = `사용 가능한 UI 컴포넌트 (OpenUI Lang):
- Chart: BarChart, LineChart, AreaChart, PieChart, RadarChart
- Data: Table, ListBlock, CodeBlock, Tag
- Layout: Card, CardHeader, Stack, Separator, Steps
- Feedback: Callout, TextCallout
- Content: TextContent, MarkDownRenderer, Image
- Action: Button(label) — 클릭하면 라벨이 사용자 메시지로 전송되어 당신에게 돌아옵니다. "다른 기간 분석해줘" 같은 후속 조치 라벨로 사용하세요

OpenUI Lang 예시:
root = Stack([chart_card, table_card])
chart_card = Card([chart_header, chart])
chart_header = CardHeader("주간 데이터")
chart = BarChart(data)
data = {"columns": ["항목", "값"], "rows": [["A", 30], ["B", 50], ["C", 20]]}

root = Stack([callout, table_card])
callout = Callout("중요 발견", "A가 예상보다 2배 높습니다")
table_card = Card([table_header, table])
table_header = CardHeader("비교")
table = Table({"columns": ["이름", "값"], "rows": [["A", "30"], ["B", "50"]]})

root = Card([CardHeader("분석 완료"), btn])
btn = Button("지난달 데이터로 다시 분석해줘")`;

registerTool({
  name: "ui.render",
  description: `Render a rich UI component (chart, table, card, callout, steps) using OpenUI Lang. Use this instead of plain text when showing data comparisons, trends, or structured findings. ${AVAILABLE_COMPONENTS}`,
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "OpenUI Lang code (see description for available components and syntax examples)" },
    },
    required: ["code"],
  },
  async execute(_ctx, args) {
    const code = String(args.code ?? "").trim();
    if (!code) return { error: "code required" };
    if (code.length > 10_000) return { error: "code too long (max 10k chars)" };
    return { rendered: true, lang: "openui", code };
  },
});

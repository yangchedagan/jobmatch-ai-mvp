// 对话情绪价值层：为确定性命令通道的固定回复注入共情、鼓励与正向反馈。
// 原则：克制真诚、具体不空洞（与淡水墨视觉气质一致）；纯函数确定性映射，不引入随机。

export function matchTone(score) {
  const value = Number(score) || 0;
  if (value >= 80) return "这个契合度很能打，你的积累和岗位要求咬合得相当好，值得认真冲一把。";
  if (value >= 65) return "底子是够的，缺口都属于短期能补的类型，别被扣分项吓到。";
  if (value >= 50) return "分数只代表当前重合度，不代表你的天花板——缺口清单就是现成的备考清单。";
  return "这个岗位重合度不高，但这也帮你排除了一个低性价比选项，把精力留给更合适的方向。";
}

export function batchTone(bestScore, count) {
  const value = Number(bestScore) || 0;
  if (value >= 75) return `${count} 个岗位里有明显的优势选项，说明你的方向感没问题。`;
  if (value >= 60) return "几个岗位各有侧重，逐份看看报告，能更清楚该往哪里使劲。";
  return "眼下分数偏保守，不用急——先看清各岗位的缺口，再决定补什么最划算。";
}

export function resumeTone(skillCount, projectCount) {
  const skills = Number(skillCount) || 0;
  const projects = Number(projectCount) || 0;
  if (skills >= 8 && projects >= 2) return "技能面和项目量都挺扎实，这份简历有得聊。";
  if (skills >= 5) return "技能储备已经成型，接下来重点是让经历和目标岗位对上焦。";
  return "内容已经立起来了，边匹配边补充，简历会越来越有说服力。";
}

export function radarTone(verifiedCount) {
  const count = Number(verifiedCount) || 0;
  if (count >= 5) return "考点和真实面经都在手上了，备考就有了明确的靶子，心里可以踏实不少。";
  return "方向已经圈出来了，照着考点逐个准备，比盲刷题效率高得多。";
}

export function interviewOpeningTone() {
  return "别紧张，这里练错的成本是零——暴露问题恰恰是模拟面试最大的价值。";
}

export function interviewClosingTone(avgScore, answeredCount) {
  if (!answeredCount) return "";
  const value = Number(avgScore) || 0;
  if (value >= 80) return "这一轮的完成度很高，保持这个状态去真实面试，你是有底气的。";
  if (value >= 60) return "整体框架已经立住了，把点评里的可提升项逐条过一遍，下一轮会明显更稳。";
  return "敢完整练下来这一轮，本身就赢过了大多数只收藏面经的人——弱项现在暴露，好过面试时暴露。";
}

export function emptySearchTone() {
  return "没找到不代表没机会，多半只是关键词没对上。";
}

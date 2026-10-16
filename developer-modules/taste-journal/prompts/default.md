# 味觉档案 · 自动记录习惯

当前版本使用稳定的 memoryId。MCP 已启用且会话已绑定时，优先使用 stmem_taste_journal_list / stats / add / update / digest，宿主绑定当前记忆体，不传其他记忆体 ID。MCP 的 options 使用 [{"key":"糖度","value":"微糖"}] 键值列表。没有这些工具时才使用下方正式 CLI，--memory 指向当前记忆体；CLI 的 options 仍是键值对象。一次体验只走一种通道记录一次，不因换通道重复提交。删除、清空和合并前取得用户明确确认。

本记忆体启用了「味觉档案」模块（taste-journal），专门记录奶茶、咖啡、甜品、外卖等吃喝体验。当用户提到喝了、点了、吃了、试了某款东西（包括回忆，比如"昨天那杯伯牙绝弦"）时：

1. 提取一条品尝记录，字段如下：
   - product.brand 品牌（必填，如"霸王茶姬"）
   - product.name 品名（必填，如"伯牙绝弦"）
   - product.category 品类：drink 饮品 / dessert 甜品 / takeout 外卖 / other 其他
   - product.tags 口味标签数组，用用户说过的词（如"桂花""乌龙""生椰"），没有就不填
   - entry.ratingId 评分：love 特别喜欢 / tried 尝鲜一次 / avoid 避雷
   - entry.options 配置键值对：糖度、冰量、温度、茶底、小料、规格等，用户提到的才写；用户说"老样子/还是那样"就不写 options，模块会沿用上次
   - entry.note 一句话短评，尽量用用户原话概括
   - entry.price 数字，只在用户明确说了金额时记录
2. 写入命令（模块会自动按品牌+品名归并到同一张档案卡，不需要先查旧记录）：
   `stmem module taste-journal add --memory <当前记忆体ID> --batch-file <临时json文件>`
   batch 文件示例：
   `{"product":{"brand":"霸王茶姬","name":"伯牙绝弦","category":"drink","tags":["茉莉"]},"entry":{"options":{"糖度":"微糖","冰量":"去冰"},"ratingId":"love","note":"茶感清冽","price":18}}`
3. 记完只回一句话确认（品名+评分），不要展开点评，不要复述记录内容，用户没问就不要罗列历史。
4. 拿不准品名或评分时，改发 `{"raw":"用户原话片段"}`，模块会存为待整理草稿，之后在模块页面补全。
5. 用户问"我喝过什么 / 某口味哪家好喝 / 帮我整理口味 / 月度报告"时，先用 `stmem module taste-journal list --memory <id> --batch-file <查询json>`（如 `{"query":{"tag":"桂花"}}` 或 `{"query":{"month":"2026-09"}}`）和 `stmem module taste-journal stats --memory <id>` 读取，再回答。
6. 用户要整理或月度报告时，把结论写回模块：
   `stmem module taste-journal digest --memory <id> --batch-file <json>`
   格式：`{"scope":"month","month":"2026-09","sections":[{"heading":"本月口味","body":"..."}],"proposals":[{"kind":"ratingLabel","label":"干杯不腻","sentiment":"positive"}]}`，proposals 可以提议新评分档位或给某张卡补充口味标签。
7. 记录本身不进入对话上下文展开；除非用户主动问起，不要主动罗列记录。

# LINE

**LINE** is a playable 2D real-time strategy prototype built with TypeScript, HTML5 Canvas, and Vite. Extend a physical logistics network, move resources as visible packets, establish real forward inventories, and drive persistent construction Arrows through a fixed hostile network to destroy its Line Center.

The main menu offers **New Game** with an easy opponent and **Debug Mode** with the familiar passive map. The Campaign entry is an empty placeholder. In New Game, the opponent slowly launches one visible, resource supplied Wood Arrow at a time; Debug Mode keeps enemy infrastructure passive.

## Start

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`.

The main menu puts New Game first, shows the empty Campaign section, and offers Debug Mode. New Game adds a slow, predictable Arrow attack after a preparation period. Debug Mode opens the same seeded map without enemy decisions.

Production build and preview:

```bash
npm run build
npm run preview
```

## Controls

| Action | Control |
| --- | --- |
| Select | Left-click; roads/cells/junctions take priority over buildings, packets, and terrain |
| Plan an unlimited-distance Arrow | Drag from a connected friendly Line/cell/junction and release |
| Queue route sections | Hold Shift while releasing |
| Add a stack layer | Drag exactly over a same-material Stone or Iron completed Line |
| Place Stone Wall | F, then left-drag anywhere physically valid |
| Continue placement | Hold Shift while placing |
| Cancel | Right-click or Escape |
| Pan | WASD, arrow keys, edge scroll, or middle-mouse drag |
| Zoom | Mouse wheel |
| Wood / Stone / Iron Arrow | 1 / 2 / 3 |
| House / Wood Camp / Quarry | H / C / Q |
| Coal Mine / Iron Mine / Depot | O / I / B |
| Request Line-cell repair/rebuild | R, then click the damaged route |
| Upgrade selected valid object | U or the same **Upgrade** inspector control |
| Manual transfer | Select a Center, Depot, or stockpile; choose resource and amount in its inspector; click **Send** and then a destination. T repeats a 10-unit transfer from the selected storage |
| Redirect commodities / create a circulation loop | Select a producer, storage, or packet; press G; click a storage or a valid closed loop. Right-click or Escape cancels |
| Select commodity packets together | Drag from empty terrain, or Alt-drag over roads |
| Redirect a packet group | Select packets, press G or **Redirect group**, then click a connected storage, junction, or completed Line point |
| Inspect a packet over a road | Alt-click the packet; ordinary clicking keeps the road easy to use |
| Select a group of commodities | Drag a box from empty ground, or Alt-drag over roads; release to select player packets inside |
| Redirect a selected group | G or **Redirect group**, then click connected storage, a junction, or a completed Line point to create a stockpile |
| Bypass packets while selecting | Hold Y while clicking to ignore packets completely |
| Spend Manpower to accelerate commodity packets | L or the **Boost** HUD button |
| Depot automatic contribution | Select a Depot and click its **⇄ Auto contribution** control |
| Producer destination | Select a producer, choose **Automatic best Depot** or a specific storage, then click **Set destination** |
| Pause / speed | Space; `-` / `+`; HUD 0.5×–4× controls |
| Mute / tutorial / debug | M / F1 / F3 |
| Debug flags | Shift+C connectivity, Shift+V routes and packet speeds, Shift+G congestion, Shift+X spatial grid |
| Minimap focus | Left-click minimap |

Green placement previews are valid; red previews state the rejection reason. Extractor previews show the same geometry-derived efficiency and expected output used by simulation. Arrow previews show material, full geometric cost, first hostile contact, base damage, target multiplier, estimated damage, and assault-bundle cost. World and inspector construction bars show delivered and in-transit supply versus the planned requirement, while inspectors separately expose stock reserved but not yet dispatched. Arrow progress is never an independent timer.

## Core rules

### Resource hierarchy

1. Connected Houses add Manpower directly to the player's workforce pool. Manpower is never a packet and never occupies Depot storage or throughput.
2. Manpower enables Wood Lines, Houses, and Wood Camps and may be spent directly on construction, repair, upgrades, and packet acceleration.
3. Delivered Wood plus available Manpower unlock Stone and Coal collection.
4. Delivered Wood, Stone, and Coal plus available Manpower enable Iron production.
5. Delivered Iron and Coal plus available Manpower unlock Iron Lines and late upgrades.

Wood, Stone, Coal, and Iron are physical commodities. Their production is accumulated fractionally at its unchanged base rate and emitted at the configured cadence as many small packets, currently up to 2 units each. By default each packet chooses the lowest-cost reachable Depot that has reserved capacity; it tries the next suitable Depot and finally the Line Center when no Depot can accept it. A player-selected destination overrides this policy. A commodity becomes stored only when its packet arrives. The top HUD aggregates physical commodity inventories while displaying the separate direct Manpower pool; neither is a teleportable commodity wallet.

Wood Camps, Quarries, Coal Mines, and Iron Mines do not receive full output merely for valid placement. One shared deterministic circle-overlap calculation measures extraction coverage against the deposit geometry and produces a smooth 0–100% efficiency. Actual output equals base output times efficiency. The placement preview and completed-producer inspector call that exact calculation; deposits are not given a separate hidden efficiency rule.

### Cell-based Lines

Every route consists of short simulation-level **Line Cells**. `LINE_CELL.length` in `src/config/balance.ts` controls their standard length; the final cell may be shorter. Each cell independently owns construction state, health, maximum health, damage feedback, collision, connectivity, repair supply, and rebuild state.

- Arrow cells have lower durability than completed cells.
- Completion converts each cell to completed durability while preserving its health percentage.
- Damage applies to the exact intersected cell, never the parent route as one health pool.
- A destroyed cell remains in the route as a rebuildable gap. Other cells remain physically present.
- A gap transports nothing, claims no territory, carries no assault/construction supply, and closes the parent graph edge.
- Upstream and downstream cells remain visible. Alternate completed routes can keep downstream nodes connected.
- A supplied rebuild restores that exact cell and immediately reopens connectivity when the rest of the path is valid.

Completed Lines are territory, logistics, resource transport, and construction infrastructure only. They never target or passively damage anything.

### Unlimited, resource-paced Arrows

An Arrow may be planned from a valid connected source to any valid point inside the world. There is no arbitrary length cap. Bounds, terrain, physical collision, unlocks, and supply connectivity are the practical constraints, while cost scales with actual geometric length.

Construction proceeds one cell at a time:

1. The order creates planned cells without reserving the final route cost.
2. A rolling window of up to 12 upcoming cells requests physical commodity bundles. Manpower is paid directly for each cell when it actually builds.
3. The marginal allocator commits small packets from the enabled storage combination expected to arrive fastest. Depots dispatch successive bundles as their outbound budgets replenish, without waiting for the first bundle to arrive.
4. Packets travel through the completed graph, enter at the Arrow source, traverse already-built Arrow cells, and reach the frontier.
5. The supplied cell interpolates into view, becomes intact, and the supply window advances. Prefetched packets travel only over built cells and wait at the construction frontier.

If resources run out, the Arrow remains at its current cell and resumes automatically after new packets arrive. Built cells of an unfinished Arrow carry only that Arrow's construction, assault, and rebuild traffic; they do not join general economic logistics or claim territory until the route completes.

Ordinary buildings use the same physical model. Placement creates an inactive structure and its existing service-connection Arrow; the building cost is distributed over that Arrow's cells and may be supplied by several real storages. The structure becomes connected and operational only after its construction packets arrive and the service Arrow completes.

When the moving tip reaches the first hostile living cell, Wall capsule, building, or Center, it holds there. Each delivered assault bundle produces one damage pulse. The Arrow survives contact, cannot hit anything behind the obstruction, and continues toward its original destination after the obstruction is destroyed. A destroyed enemy Line cell creates a real opening; the Arrow can pass through it and later encounter another surviving cell.

If any built Arrow cell behind the tip breaks, construction and damage stop immediately. Supply always rebuilds the first gap measured from the source before anything can travel farther. The same Arrow then resumes automatically; it is never deleted or recreated.

| Material | Damage per assault bundle | Cost per pulse | Cell construction pace | Role |
| --- | ---: | --- | --- | --- |
| Wood | 35 | 1 direct Manpower + 1 shipped Wood | Fastest | Expansion and light targets |
| Stone | 80 | 2 direct Manpower + 1 shipped Stone | Medium | Midgame pressure |
| Iron | 180 | 3 direct Manpower + 1 shipped Coal + 1 shipped Iron | Slowest | Fortified Lines, Walls, and Center assaults |

### Physical inventories and dispatch

Line Centers, Depots, and forward stockpiles own real Wood, Stone, Coal, and Iron inventories. They do not store Manpower. A storage may dispatch only available commodity stock it actually contains. Committed stock remains physically stored but is marked reserved so it cannot be promised twice; dispatch atomically removes it from inventory, releases that reservation, and creates exactly one packet. Construction, building supply, assault, repair/rebuild, Depot resupply, production, and manual transfer move every physical commodity through visible A-to-B packets. Rerouting never creates a duplicate or returns resources by teleportation.

Each Depot has one shared `DEPOT.maxStorage` capacity across all resource types. Packets reserve incoming capacity before departure, so stored quantity plus incoming reservations can never overbook the Depot. A rerouted packet releases its old destination reservation before reserving its new one. An empty Depot cannot materialize Center stock, and a full Depot cannot silently accept another packet.

Project supply is not tied to one closest origin. A deterministic marginal allocator evaluates the next small packet from each eligible storage using available inventory, existing reservations, shared dispatch queue, outbound rate, weighted route travel time, directional capacity/load, congestion, stacks, and alternate paths. It assigns each physical resource independently to the next candidate with the earliest projected arrival, updates projected queues, and repeats. Wood, Stone, Coal, and Iron can therefore come from different combinations of several Depots without brute-forcing every subset. Direct Manpower is checked and spent separately.

Each Depot's **Auto contribution** state defaults on. Turning it off removes only its not-yet-dispatched automatic construction, repair, and assault commitments. It still stores and receives resources, and explicit transfers may still dispatch from it. Planning is reconsidered on meaningful inventory, topology, toggle, or congestion-version changes and at a coarse deterministic cadence; packets already traveling keep their objective unless its route becomes invalid.

Every Depot has one commodity-only token-bucket outbound cap, `DEPOT.maxOutboundUnitsPerSecond`. Wood, Stone, Coal, and Iron share that budget across simultaneous Arrows, buildings, repairs, assaults, and transfers. Each Depot also has a separate, higher `DEPOT.maxInboundUnitsPerSecond` ingress budget, so receiving traffic does not consume outbound capacity. Storage reservations still prevent overfill. More connected Lines and higher stack levels do not raise either Depot ceiling, while several Depots legitimately provide independent throughput. An enlarged logical connection socket lets several incoming/outgoing Lines, mixed route materials, stacks, and loops use one Depot as a hub.

To create a forward stockpile, send a manual transfer to an existing connected junction or to a point on a completed Line. A Line-point destination is split cleanly and becomes a storage junction. Delivered resources remain there until consumed by a nearby request or manually transferred elsewhere. Storage inspectors show stored/max capacity, per-resource reserved and available stock, incoming reserved capacity, dispatch budget/load, queued transfers, and automatic-contribution state.

### Directional lanes, stacking, and packet acceleration

Dragging a route deliberately and geometrically exactly over a completed friendly Line of the same material adds a stack level instead of creating duplicate graph edges. Accidental crossings and mixed-material overlaps remain invalid. Wood cannot stack; Stone may stack once to x2; Iron may add further layers without an arbitrary gameplay cap.

- Stone supports x1 and x2 route acceleration; Iron supports x1, x2, x3, and further levels. Wood remains x1.
- Adding layer `N` costs `N ×` the base route cost and is itself supplied cell by cell.
- Cumulative cost is exactly `N × (N + 1) / 2`: 1×, 3×, 6×, 10×, 15×…
- Stack levels improve both packet travel speed and each direction's independent transport capacity at x1, x2, x3, and so on. They never increase Depot output or combat damage.

Completed Lines provide separate lanes in both directions:

| Material | A → B lanes | B → A lanes |
| --- | ---: | ---: |
| Wood | 1 | 1 |
| Stone | 2 | 2 |
| Iron | 3 | 3 |

Stack level multiplies those capacities independently. A Stone x2 route, for example, has four lanes A → B and four lanes B → A. Traffic in one direction consumes only that direction's normal capacity.

Every packet stores a persistent cruise multiplier and a separate effective multiplier. Entering faster infrastructure raises cruise speed; later slower infrastructure and rerouting do not lower it. Route choice incorporates directional load, so equivalent loop routes can carry different packets instead of forcing every journey through one shortest edge. Bends, cells, direction changes, and junction turns add no congestion by themselves.

Each direction derives its traffic state from its own actual load divided by its effective lane capacity. Speed resolution is centralized and deterministic:

| Own direction | Opposite direction | Effective multiplier |
| --- | --- | ---: |
| FREE | FREE or CONGESTED | stored cruise speed |
| CONGESTED | any | 1× |
| HEAVY | any | 0.25× |
| FREE | HEAVY | stored cruise speed × 0.5 |

Normal congestion in A → B does not slow B → A. Heavy oversaturation partially interferes with the opposite direction, but does not stop it. The packet's stored stack/Manpower acceleration is never erased: it becomes effective again after leaving the bottleneck. Severe overload can queue packets before edge entry without deleting or merging them. A stacked corridor can prevent congestion through higher directional capacity, but speed bonuses cannot overpower a real bottleneck.

The **Boost** toggle spends `LOGISTICS_ACCELERATION.manpowerCostPerPacket` directly from the player's Manpower pool for each boosted commodity packet. A successfully funded boost raises that packet's stored cruise speed for its current trip. Insufficient Manpower means no boost; congestion affects only its current effective speed.

### Redirection and circulating commodities

Select a producer, physical storage, or commodity packet and press G, then click a valid storage or a recognized loop. A recognized loop has at least three completed roads forming a cycle and exactly one completed road joining the cycle to the rest of the network. Existing packets change objective from their current legitimate position: they are not deleted, refunded, or recreated. Right-click or Escape cancels the preview.

To redirect several commodities together, drag a selection box from empty terrain or hold Alt while dragging over infrastructure. The inspector shows selected packet counts and totals by commodity. Press G or **Redirect group**, then click connected storage, a junction, or a completed Line point. A Line point becomes a real stockpile and existing road traffic retains its position. Packets already on an Arrow return physically to its network entry before taking the new route; redirected project commitments are released so automatic supply can replace them. Full storage makes pending packets wait for capacity; missing or unreachable packets are reported and retain their orders. Holding Y excludes packets from box selection too.

Storage on a recognized loop is labeled in its inspector. Loop storage and circulating packets are excluded from automatic supply to new structure service routes, so a loop cannot become a structure's main supplier.

A deliberate circulation order caches a deterministic closed path and advances one edge at a time across simulation ticks. Its commodity continues through repeated cycles until it is stored, manually redirected, intercepted exactly once by an eligible construction/repair/assault request, or blocked by a physical cut. A cut makes the packet wait at its nearest valid network position; restored topology lets it resume. This is a moving buffer, not a same-tick pathfinding loop.

Road cells and junctions have normal selection priority over packet traffic, including at different zoom levels and when a cell is damaged or broken. Packets remain selectable wherever no road overlaps; Alt-click explicitly inspects a packet over a road. Holding Y bypasses production, construction, repair, assault, and circulating packets completely for pointer hit-testing.

### Repair and rebuild

R requests repair for the first damaged/broken cell on the selected route. It does not change health or deduct an abstract commodity cost. The selected cell requests the same cost used by one assault pulse of its material: physical components travel visibly, its Manpower component is paid directly, and only the complete delivered requirement applies `repairHealthPerSupply`. Completely broken cells use the same mechanism. The easy opponent does not repair automatically.

### Stone Walls

Stone Walls cost Stone and Manpower, start at roughly 300 health, and may be placed anywhere in world bounds without nearby friendly territory. Physical terrain, building, resource, living Line-cell, and Wall overlap checks still apply; adjacent endpoints snap to avoid gaps.

Walls are completely passive. They never fire, retaliate, transport, claim territory, launch Lines, act as endpoints, store packets, or enter the graph. Collision uses full segment thickness.

| Incoming Arrow | Wall multiplier |
| --- | ---: |
| Wood | 0.40× |
| Stone | 1.00× |
| Iron | 2.00× |

## Scenario

Seed `2405` deterministically creates:

- one player Center, a small completed Wood network, early resources, and accessible Wood;
- Stone and Coal farther away, with rare Iron in the contested middle;
- ridges, water chokepoints, and alternate corridors;
- a stationary enemy Center, passive Wood/Stone/Iron network, and several passive Stone Walls;
- guarded direct approaches plus routes around the fortifications.

Destroy the enemy Center to win. Lose when the player Center reaches zero health. Restart regenerates the same seed without reloading. Settings remain in local storage.

## Architecture

```text
src/
  audio/       procedural Web Audio effects
  config/      all durability, cost, cell, storage, throughput, speed, and production balance
  core/        state/entities, geometry, seeded RNG, settings
  game/        deterministic 30 Hz fixed-step orchestration and restart
  input/       camera, gestures, UI-owned pointers, hotkeys, redirect/loop destinations, previews
  map/         seeded terrain/resources and static opponent scenario
  render/      camera-culled Canvas cells, gaps, stacks, packets, effects, minimap, debug
  systems/     cells, graph, storage, logistics, construction, collision, combat, economy, Walls
  tests/       deterministic Vitest simulation coverage
  ui/          resources, inspector, controls, tutorial, objectives, results
```

`GameState` remains the simulation boundary. Parent `LineSegment` entities provide route identity, selection, endpoints, and one unambiguous graph edge; their `LineCell` entities are authoritative for durability and physical continuity. `systems/cells.ts` centralizes cell costs, passability, health aggregation, stack math, and construction-supply progress.

`systems/graph.ts` builds directional load-aware weighted routes from completed, fully passable parent edges, scales each direction's lane capacity by stack level, resolves FREE/CONGESTED/HEAVY speed centrally, finds deterministic circulation cycles, and annotates surviving cell spans around gaps. `systems/storage.ts` owns commodity inventories, committed stock, incoming capacity reservations, stockpiles, accounting, toggles, and transfer orders while keeping Manpower separate. `systems/logistics.ts` owns fractional small-packet production, direct House workforce output, best-Depot destination selection, the deterministic marginal multi-storage allocator, independent Depot ingress/egress budgets, directional edge queues, Arrow-front traversal, cut handling, cruise/effective speed, redirection, circulation, interception, and delivery. `systems/extraction.ts` is the shared preview/simulation geometry calculation. `systems/collision.ts` spatially indexes living cells rather than monolithic route capsules. `systems/combat.ts` damages exact cells/structures and evaluates victory. Rendering reads simulation state but never drives it.

`systems/enemyAI.ts` contains the easy opponent. It chooses a forward connected enemy node and launches one slow Wood Arrow at the player's easternmost connected node after a fixed opening delay. Debug Mode leaves this controller off; the Campaign menu entry remains a placeholder.

## Automated tests

```bash
npm test
```

The Vitest suite covers deterministic simulation and input scenarios, including:

- continuous Depot dispatch before first arrival, bounded prefetch, and conservation through construction;
- commodity box selection, Y bypass, cancellation, group redirect to new stockpiles, and preserved road traffic positions;
- physical Arrow-cargo return and release of redirected construction commitments;

- unlimited-distance validation and eventual completion;
- no whole-route reservation, per-cell delivery pacing, pause, and resume;
- fixed independent Arrow/completed cell health and local damage;
- real gaps, downstream disconnection, exact supplied rebuild, and packet conservation at cuts;
- rear/frontier-cell Arrow gating, supplied rebuilding, and automatic resumption of the same Arrow;
- visible repair packets with assault-equivalent bundles;
- first-obstruction and repeated supplied assault behavior;
- empty Depot rejection, physical Center-to-Depot resupply, weighted nearest-end repair dispatch, and conservation;
- fixed shared Depot outbound throughput under simultaneous demand and stacking;
- independent high-rate Depot ingress and egress, simultaneous inbound Lines, and storage-capacity enforcement;
- commodity-only Depot storage, incoming-capacity reservations, full-Depot fallback, and capacity release;
- small frequent production packets, unchanged aggregate rate, and fractional accumulation;
- weighted best-Depot production routing plus explicit destination override;
- multi-Depot, per-resource marginal allocation, real stock reservations, auto-contribution exclusion, and physical building supply;
- faster farther/stacked routes, insufficient origins, parallel-loop traffic distribution, and turn neutrality;
- exact Wood/Stone/Iron directional lane counts, independent opposite traffic, and stack-scaled lanes in both directions;
- FREE/CONGESTED/HEAVY directional states with exact x3, x1, x0.25, and opposite-heavy x1.5 resolution;
- temporary directional congestion suppression and restoration of stack-derived and Manpower-derived cruise acceleration;
- smooth optimal/medium/edge/invalid extraction geometry for all four extractor types with preview/simulation parity;
- manual stockpiles and use as local supply origins;
- exact triangular stack cost, Wood/Stone/Iron eligibility, Stone x2 cap, and Iron x2/x3 route acceleration;
- persistent cruise speed across slower Lines and reroutes;
- direct-pool Manpower production, spending, and acceleration with no packets, Depot space, reservations, or commodity routes;
- in-place packet redirection, conserved quantities, multi-cycle circulation, cut waiting/resume, and one-time request interception;
- Y selection bypass for every commodity packet type while preserving packet inspection without Y;
- Walls outside territory, physical collision, graph isolation, and passivity;
- passive completed Lines, exact Wall multipliers, local enemy-cell destruction/connectivity, and victory.

Full verification:

```bash
npm test
npm run build
```

## Balance configuration

All new values are centralized in `src/config/balance.ts`:

- `LINE_CELL`: cell length, seams, and frontier interpolation;
- `TIER_BALANCE`: geometric cost, Arrow/completed cell durability, repair health, armor, assault bundle/damage/interval, lanes per direction, packet speed, construction pace, width;
- `DEPOT`: shared commodity storage, support field, connection socket, and independent fixed inbound/outbound rates;
- `STORAGE`: Center/stockpile output, small packet size, production cadence, and allocation cadence;
- `STACKING`: deliberate-overlap tolerances, material-specific maximum levels, speed/capacity scaling, and rendering;
- `CONGESTION`: directional normal/heavy thresholds, exact effective-speed and opposite-heavy multipliers, severe entry queue, route penalty, smoothing, and meaningful-change threshold;
- `EXTRACTION`: shared geometry, falloff, placement threshold, and resource-specific extraction radii;
- `LOGISTICS_ACCELERATION`: direct-pool Manpower cost and persistent cruise-speed multiplier;
- `WALL_BALANCE`, `BUILDING_BALANCE`, and `WORLD`: remaining shared rules.

Tune assault damage, repair health, resource bundles, Depot storage/rates, packet cadence, extraction coverage, directional Line lanes, and travel time together. A well-stocked forward Depot should sustain pressure but cannot exceed its storage or dispatch ceilings; stacks prevent traffic bottlenecks without manufacturing resources or increasing attack damage.

## Known limitations

- One deterministic assault scenario is included; there is no save game, replay, or scenario selector.
- Manual transfer destinations use Centers, Depots, connected junctions, existing stockpiles, or a split point on a completed Line; there is no free-standing off-network warehouse.
- A route-level Repair selection services its first damaged cell from a reachable end; direct per-cell click prioritization is not yet exposed.
- Stack operations require same-material, near-identical endpoint geometry. Wood cannot stack, Stone is capped at x2, and mixed materials can never occupy one stack. Upgrade the whole route first if a different material is desired.
- One packet remains conserved as one journey; allocation achieves splitting through many small packets from several origins and loop routes rather than cloning one payload.
- Terrain uses sampled procedural ellipses rather than arbitrary polygon collision meshes.
- Walls are straight capsules without gates or curves.
- Mouse and keyboard are the primary input; touch support is basic.
- The opponent cannot replace anything. This is intentional, not an AI implementation.

## Recommended next steps

1. Add per-cell repair priority, cancellation, demolition, and transfer-order management UI.
2. Add transfer-order cancellation/reordering and per-resource Depot reserve targets.
3. Add more deterministic scenarios, replay serialization, and accessibility options.
4. Add Wall gates and richer procedural fortification shapes.
5. Add enemy AI only as a future, optional controller using the existing public commands; keep it separate from shared simulation systems.

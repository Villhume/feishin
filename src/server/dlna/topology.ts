/**
 * Sonos topology helpers — pure functions for parsing ZoneGroupState XML,
 * consolidating discovered devices with topology info, and enriching the
 * discovery list with group/stereo-pair metadata.
 *
 * Extracted from src/main/features/core/dlna/index.ts so the same logic
 * serves both the Electron IPC adapter and the standalone casting server.
 *
 * These functions are stateless and have no side effects on the controller.
 */
import http from 'http';

import type { DlnaDevice } from '/@/shared/types/dlna';

export interface TopologyLogger {
    info: (action: string, err?: unknown) => void;
}

export function createTopologyHelpers(logger: TopologyLogger) {
    function getAttr(attrString: string, name: string): string {
        const m = attrString.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'));
        return m ? m[1] : '';
    }

    function fetchTopologyForDevice(device: DlnaDevice): Promise<string> {
        return new Promise((resolve) => {
            try {
                const parsedUrl = new URL(device.controlUrl);
                const controlUrl = `http://${parsedUrl.hostname}:1400/ZoneGroupTopology/Control`;
                logger.info(`[Discovery/Topology] Requesting from ${device.name} at ${controlUrl}`);
                const body = `<?xml version="1.0" encoding="utf-8"?>
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                <s:Body>
                    <u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState>
                </s:Body>
            </s:Envelope>`;
                const req = http.request(
                    controlUrl,
                    {
                        headers: {
                            Connection: 'close',
                            'Content-Length': Buffer.byteLength(body, 'utf8'),
                            'Content-Type': 'text/xml; charset="utf-8"',
                            SOAPAction:
                                '"urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState"',
                        },
                        method: 'POST',
                    },
                    (res) => {
                        logger.info(`[Discovery/Topology] HTTP ${res.statusCode} from ${device.name}`);
                        let data = '';
                        res.on('data', (chunk) => (data += chunk));
                        res.on('end', () => {
                            logger.info(
                                `[Discovery/Topology] Response ${data.length} bytes from ${device.name}`,
                            );
                            if (data.includes('GetZoneGroupStateResponse')) {
                                resolve(data);
                            } else {
                                logger.info(
                                    `[Discovery/Topology] Guard failed for ${device.name}: ${data.substring(0, 200).replace(/\s+/g, ' ')}`,
                                );
                                resolve('');
                            }
                        });
                    },
                );
                req.on('error', (err) => {
                    logger.info(`[Discovery/Topology] Error from ${device.name}: ${err.message}`);
                    resolve('');
                });
                req.setTimeout(5000, () => {
                    logger.info(`[Discovery/Topology] Timeout for ${device.name}`);
                    req.destroy();
                    resolve('');
                });
                req.write(body);
                req.end();
            } catch (err: any) {
                logger.info(`[Discovery/Topology] Exception for ${device.name}: ${err?.message}`);
                resolve('');
            }
        });
    }

    function consolidateDiscoveredDevices(
        devices: DlnaDevice[],
        decodedTopology: string,
    ): DlnaDevice[] {
        const zoneGroupRegex = /<ZoneGroup\b[^>]*>[\s\S]*?<\/ZoneGroup>/g;
        const zoneGroups = decodedTopology.match(zoneGroupRegex);
        logger.info(`[Consolidate] Total ZoneGroup blocks matched: ${zoneGroups?.length ?? 0}`);
        if (!zoneGroups) return devices;
        const deviceById = new Map<string, DlnaDevice>(devices.map((d) => [d.id, d]));
        const groupedIds = new Set<string>();
        const groupEntries: DlnaDevice[] = [];
        for (let gi = 0; gi < zoneGroups.length; gi++) {
            const group = zoneGroups[gi];
            const groupTagMatch = group.match(/^<ZoneGroup\b([^>]*)>/);
            if (!groupTagMatch) {
                logger.info(`[Consolidate] Group[${gi}]: no opening tag match, skipping`);
                continue;
            }
            const coordinatorUuid = getAttr(groupTagMatch[1], 'Coordinator');
            logger.info(`[Consolidate] Group[${gi}]: Coordinator UUID="${coordinatorUuid}"`);
            if (!coordinatorUuid) continue;
            const coordinatorId = `uuid:${coordinatorUuid}`;
            const memberDevices: DlnaDevice[] = [];
            const memberTagRegex = /<ZoneGroupMember\b([^>]*)\/?>/g;
            let tagMatch: null | RegExpExecArray;
            while ((tagMatch = memberTagRegex.exec(group)) !== null) {
                const attrs = tagMatch[1];
                const uuid = getAttr(attrs, 'UUID');
                const location = getAttr(attrs, 'Location');
                const zoneName = getAttr(attrs, 'ZoneName');
                logger.info(
                    `[Consolidate] Group[${gi}] member: UUID="${uuid}" ZoneName="${zoneName}" Location="${location}"`,
                );
                if (!uuid || !location) {
                    logger.info(`[Consolidate] Group[${gi}] member skipped: missing UUID or Location`);
                    continue;
                }
                const fullId = `uuid:${uuid}`;
                const existing = deviceById.get(fullId);
                if (existing) {
                    logger.info(
                        `[Consolidate] Group[${gi}] member "${zoneName}": matched discovered device "${existing.name}"`,
                    );
                    memberDevices.push(existing);
                } else {
                    logger.info(
                        `[Consolidate] Group[${gi}] member "${zoneName}" (${fullId}): NOT in discovered list, building from topology`,
                    );
                    try {
                        const base = new URL(location);
                        const baseUrl = `${base.protocol}//${base.hostname}:1400`;
                        memberDevices.push({
                            controlUrl: `${baseUrl}/MediaRenderer/AVTransport/Control`,
                            id: fullId,
                            location,
                            name: zoneName || uuid,
                            renderingControlUrl: `${baseUrl}/MediaRenderer/RenderingControl/Control`,
                        });
                    } catch (e: any) {
                        logger.info(`[Consolidate] Group[${gi}] member URL parse failed: ${e?.message}`);
                        continue;
                    }
                }
            }
            logger.info(`[Consolidate] Group[${gi}]: ${memberDevices.length} members total`);
            if (memberDevices.length === 1) {
                continue;
            }
            if (memberDevices.length < 2) {
                logger.info(`[Consolidate] Group[${gi}]: fewer than 2 members, skipping`);
                continue;
            }
            for (const m of memberDevices) {
                groupedIds.add(m.id);
            }
            const coordinator =
                deviceById.get(coordinatorId) ?? memberDevices.find((m) => m.id === coordinatorId);
            if (!coordinator) {
                logger.info(
                    `[Consolidate] Group[${gi}]: coordinator ${coordinatorId} not resolvable, skipping`,
                );
                continue;
            }
            const isStereoGroup =
                group.includes('ChannelMapSet=') && !group.includes('HTSatChanMapSet=');
            if (isStereoGroup) {
                const firstMemberMatch = group.match(/<ZoneGroupMember\b([^>]*)\/?>/);
                const pairName = firstMemberMatch
                    ? getAttr(firstMemberMatch[1], 'ZoneName') || coordinator.name
                    : coordinator.name;
                logger.info(`[Consolidate] Group[${gi}]: stereo pair detected, name="${pairName}"`);
                for (const m of memberDevices) groupedIds.add(m.id);
                groupEntries.push({
                    ...coordinator,
                    isPair: true,
                    name: `${pairName} (Stereo Pair)`,
                });
                continue;
            }
            const sortedMembers = [coordinator, ...memberDevices.filter((m) => m.id !== coordinatorId)];
            logger.info(
                `[Consolidate] Group[${gi}]: creating group entry "${coordinator.name}" with ${sortedMembers.length} members`,
            );
            groupEntries.push({
                ...coordinator,
                groupCoordinatorId: coordinatorId,
                groupMembers: sortedMembers,
                name: `Group (${sortedMembers.length})`,
            });
        }
        logger.info(`[Consolidate] groupedIds: ${JSON.stringify([...groupedIds])}`);
        logger.info(`[Consolidate] groupEntries count: ${groupEntries.length}`);
        const remaining = devices.filter((d) => !groupedIds.has(d.id));
        logger.info(`[Consolidate] remaining solo devices: ${remaining.map((d) => d.name).join(', ')}`);
        return [...remaining, ...groupEntries];
    }

    async function enrichDevicesWithTopology(devices: DlnaDevice[]): Promise<DlnaDevice[]> {
        const sonosDevices = devices.filter((d) => d.id.toUpperCase().includes('RINCON'));
        if (sonosDevices.length === 0) return devices;
        logger.info(
            `[Discovery/Topology] Starting parallel topology scan for ${sonosDevices.length} Sonos device(s)`,
        );
        const attemptDelays = [1000, 2000, 4000, 6000];
        for (let attempt = 0; attempt < attemptDelays.length; attempt++) {
            await new Promise((r) => setTimeout(r, attemptDelays[attempt]));
            logger.info(`[Discovery/Topology] Attempt ${attempt + 1}/${attemptDelays.length} (parallel)`);
            const allResults = await Promise.all(
                sonosDevices.map((sonosDevice) =>
                    fetchTopologyForDevice(sonosDevice)
                        .then((raw) => {
                            if (!raw) return null;
                            const stateMatch = raw.match(
                                /<ZoneGroupState>([\s\S]*?)<\/ZoneGroupState>/,
                            );
                            if (!stateMatch) return null;
                            return stateMatch[1]
                                .replace(/&lt;/g, '<')
                                .replace(/&gt;/g, '>')
                                .replace(/&quot;/g, '"')
                                .replace(/&amp;/g, '&');
                        })
                        .catch(() => null),
                ),
            );
            let bestResult: DlnaDevice[] | null = null;
            let bestScore = 0;
            let anyResponded = false;
            for (const rawSoap of allResults) {
                if (!rawSoap) continue;
                anyResponded = true;
                const consolidated = consolidateDiscoveredDevices(devices, rawSoap);
                const score = consolidated.filter((d) => d.groupMembers || d.isPair).length;
                if (score > bestScore) {
                    bestScore = score;
                    bestResult = consolidated;
                }
            }
            if (bestResult && bestScore > 0) {
                logger.info(
                    `[Discovery/Topology] Result: ${bestResult.length} entries (groups/pairs found)`,
                );
                return bestResult;
            }
            if (anyResponded) {
                logger.info(
                    '[Discovery/Topology] Topology received but no groups/pairs found, returning flat list',
                );
                return devices;
            }
            logger.info(`[Discovery/Topology] Attempt ${attempt + 1}: no topology from any device`);
        }
        logger.info('[Discovery/Topology] All attempts exhausted, returning flat device list');
        return devices;
    }

    return { getAttr, fetchTopologyForDevice, consolidateDiscoveredDevices, enrichDevicesWithTopology };
}

export type TopologyHelpers = ReturnType<typeof createTopologyHelpers>;

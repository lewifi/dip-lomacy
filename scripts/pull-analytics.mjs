import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

async function run() {
  const configPath = join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml');
  const toml = await readFile(configPath, 'utf8');

  const match = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match) {
    console.error('No oauth_token found in default.toml');
    return;
  }
  const token = match[1];

  // 1. Get Zone ID for dip-lomacy.com
  const zonesRes = await fetch('https://api.cloudflare.com/client/v4/zones?name=dip-lomacy.com', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const zonesData = await zonesRes.json();
  if (!zonesData.result || zonesData.result.length === 0) {
    console.error('Zone not found:', zonesData);
    return;
  }
  const zoneId = zonesData.result[0].id;
  console.log(`Found Zone ID for dip-lomacy.com: ${zoneId}`);

  // 2. Query GraphQL analytics for the past 24 hours
  const now = new Date();
  const past24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const query = `
    query ZoneTraffic($zoneTag: String!, $since: String!, $until: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequests1hGroups(
            limit: 100,
            filter: { datetime_geq: $since, datetime_leq: $until },
            orderBy: [datetime_ASC]
          ) {
            dimensions {
              datetime
            }
            sum {
              requests
              pageViews
              bytes
              threats
              responseStatusMap {
                edgeResponseStatus
                requests
              }
              countryMap {
                clientCountryName
                requests
              }
            }
          }
        }
      }
    }
  `;

  const gqlRes = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      variables: {
        zoneTag: zoneId,
        since: past24h.toISOString(),
        until: now.toISOString()
      }
    })
  });

  const gqlData = await gqlRes.json();
  const groups = gqlData.data?.viewer?.zones?.[0]?.httpRequests1hGroups || [];

  console.log(`Retrieved ${groups.length} hourly traffic intervals.`);

  // Write full JSON
  await writeFile('cloudflare_traffic_24h.json', JSON.stringify(groups, null, 2), 'utf8');

  // Format into CSV
  const csvRows = ['Datetime,Total_Requests,PageViews,Bytes,Threats,Top_Countries,Status_Codes'];
  for (const g of groups) {
    const dt = g.dimensions.datetime;
    const reqs = g.sum.requests;
    const pvs = g.sum.pageViews;
    const bytes = g.sum.bytes;
    const threats = g.sum.threats;
    const countries = (g.sum.countryMap || [])
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 5)
      .map(c => `${c.clientCountryName}:${c.requests}`)
      .join(' | ');
    const statuses = (g.sum.responseStatusMap || [])
      .map(s => `${s.edgeResponseStatus}:${s.requests}`)
      .join(' | ');

    csvRows.push(`"${dt}",${reqs},${pvs},${bytes},${threats},"${countries}","${statuses}"`);
  }

  await writeFile('cloudflare_traffic_24h.csv', csvRows.join('\n'), 'utf8');
  console.log('Saved cloudflare_traffic_24h.csv and cloudflare_traffic_24h.json');
}

run().catch(console.error);

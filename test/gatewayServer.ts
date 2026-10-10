// Runs the fake HSFZ gateway as a standalone server (CI: the iOS app in the Simulator connects
// to it over TCP). Writes the port to the file given as the first argument.
import { writeFileSync } from 'node:fs'
import { FakeGateway } from './fakeGateway'

async function main(): Promise<void> {
  const gw = await FakeGateway.start()
  writeFileSync(process.argv[2] ?? 'gateway.port', String(gw.port))
  console.log(`Fake gateway listening on 127.0.0.1:${gw.port}`)
  setInterval(() => console.log(`${gw.requests.length} requests so far`), 5000)
}

void main()

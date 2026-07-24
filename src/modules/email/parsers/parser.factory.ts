import type { EmailParser, RawEmailMessage, ShipmentSource } from "../models/types.js";
import { ushipParser } from "../parsers/uship/uship.parser.js";

const parsers: EmailParser[] = [ushipParser];

export class ParserFactory {
    resolve(email: RawEmailMessage): EmailParser | null {
        return parsers.find((p) => p.canParse(email)) ?? null;
    }

    register(parser: EmailParser) {
        parsers.push(parser);
    }

    listSources(): ShipmentSource[] {
        return parsers.map((p) => p.source);
    }
}

export const parserFactory = new ParserFactory();

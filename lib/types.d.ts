// Shared types of the adapter modules (JSDoc in the .js files refers to them with import('./types').X)

/** Logger of the adapter */
export interface Logger {
    /** Debug line */
    debug(msg: string): void;
    /** Info line */
    info(msg: string): void;
    /** Warning */
    warn(msg: string): void;
    /** Error */
    error(msg: string): void;
}

/** A favourite station */
export interface Station {
    /** Object id part */
    id: string;
    /** Name */
    name: string;
    /** Stream URL */
    url: string;
    /** Logo URL at the station (cached by the adapter), empty = none */
    logo: string;
    /** Tags */
    tags: string[];
    /** Station uuid at radio-browser.info, empty = added by hand */
    uuid: string;
}

/** Kind of player */
export type TargetKind = 'assistant' | 'satellite-display' | 'dune' | 'custom';

/** A player that takes a URL */
export interface Target {
    /** Object id part */
    id: string;
    /** Name */
    name: string;
    /** Which preset filled the empty fields */
    kind: TargetKind;
    /** State that takes the stream URL */
    urlState: string;
    /** State written to stop the target */
    stopState: string;
    /** Value written to the stop state */
    stopValue: ioBroker.StateValue;
    /** Volume state of the target, empty = none */
    volumeState: string;
    /** Title state of the target, empty = none */
    titleState: string;
    /** Byte limit of the title text, 0 = none */
    titleBytes: number;
    /** auto = by kind, direct = the station URL, flac/mp3 = through the proxy */
    stream: 'auto' | 'direct' | 'flac' | 'mp3';
    /** Device object of the player, empty = none */
    device: string;
    /** Found automatically (not a row of the settings) */
    discovered: boolean;
    /** URL states of other players of the same device (an assistant satellite that is also a panel) */
    aliases: string[];
}

/** The used resources calls of js-controller 8 (not in the typings of 7) */
export interface UsedResourcesApi {
    /** Whether the controller has a feature */
    supportsFeature?: (feature: string) => boolean;
    /** Other running instances that declare the port */
    checkUsedResource: (type: 'tcpPort', data: { port: number; bind?: string }) => Promise<{ instance: string }[]>;
    /** Declares a port of this instance */
    registerUsedResource: (type: 'tcpPort', data: { port: number; bind?: string }) => Promise<void>;
}

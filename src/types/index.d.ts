export interface Addon {
    id: number;
    name: string;
    file_name: string;
    type: Type;
    description: string;
    version: string;
    author: Author;
    likes: number;
    downloads: number;
    tags: string[];
    thumbnail_url: null | string;
    latest_source_url: string;
    initial_release_date: Date;
    latest_release_date: Date;
    guild: Guild | null;
}

export interface Author {
    github_id: string;
    github_name: string;
    display_name: string;
    discord_name: string;
    discord_avatar_hash: null | string;
    discord_snowflake: string;
    guild: Guild | null;
}

export interface Guild {
    name: string;
    snowflake: string;
    invite_link: string;
    avatar_hash: null | string;
}

export enum Type {
    Plugin = "plugin",
    Theme = "theme",
}

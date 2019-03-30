import Phaser from 'phaser';
import {BackendState, GameDimensions, PlayerDirections, SocketEvents} from 'commons';
import {ASSETS, MAIN_TILES, MAPS} from "./assets";
import Socket = SocketIOClient.Socket;

interface Directions {
    left: boolean,
    right: boolean,
    down: boolean,
    up: boolean
}

interface SceneMap {
    map: Phaser.Tilemaps.Tilemap,
    tiles: Phaser.Tilemaps.Tileset,
    layer: Phaser.Tilemaps.DynamicTilemapLayer
}

function inRange({min, max, value}: { min: number, max: number, value: number }) {
    return value >= min && value <= max
}

export class BombGame {
    private socket: Socket;
    private backgroundMap: SceneMap;
    private breakableMap: SceneMap;
    private wallsMap: SceneMap;

    private playerRegistry: {
        [id: string]: {
            directions: PlayerDirections,
            player: Phaser.Physics.Arcade.Sprite
        }
    } = {};

    constructor(socket: Socket) {
        this.socket = socket
    }

    private static makeDefaultTileMap(
        scene: Phaser.Scene,
        key: string,
        imageName: string
    ): SceneMap {
        const map = scene.make.tilemap({
            key,
            tileWidth: GameDimensions.tileWidth,
            tileHeight: GameDimensions.tileHeight
        });

        const tiles = map.addTilesetImage(imageName);
        const layer = map.createDynamicLayer(0, tiles, 0, 0);

        return {
            layer, map, tiles
        }
    }


    private static preload(scene: Phaser.Scene) {
        scene.load.image(MAIN_TILES, 'assets/tileset.png');
        scene.load.tilemapCSV(MAPS.BACKGROUND, 'assets/map_background.csv');
        scene.load.tilemapCSV(MAPS.WALLS, 'assets/map_walls.csv');
        scene.load.tilemapCSV(MAPS.BREAKABLES, 'assets/map_breakables.csv');
        scene.load.spritesheet(ASSETS.PLAYER,
            'assets/dude.png', {
                frameWidth: GameDimensions.playerWidth,
                frameHeight: GameDimensions.playerHeight
            }
        );
    }

    private static applyPhysicsAndAnimations(
        sprite: Phaser.Physics.Arcade.Sprite,
        {left, right, down, up}: Directions
    ) {
        const velocity = 160;
        if (left) {
            sprite.setVelocityX(-velocity);
            sprite.anims.play('left', true);
        } else if (right) {
            sprite.setVelocityX(velocity);
            sprite.anims.play('right', true);
        } else {
            sprite.setVelocityX(0);
            sprite.anims.play('turn');
        }

        if (down) {
            sprite.setVelocityY(-velocity);
        } else if (up) {
            sprite.setVelocityY(velocity);
        } else {
            sprite.setVelocityY(0);
        }
    }

    startGame() {
        const self = this;

        new Phaser.Game({
            type: Phaser.AUTO,
            width: GameDimensions.gameWidth,
            height: GameDimensions.gameHeight,
            physics: {
                default: 'arcade',
                arcade: {
                    gravity: {},
                    debug: true
                }
            },
            scene: {
                preload: function (this: Phaser.Scene) {
                    BombGame.preload(this)
                },
                create: function (this: Phaser.Scene) {
                    self.create(this)
                },
                update: function (this: Phaser.Scene) {
                    self.update(this)
                }
            }
        });

        // Listen to disconnections
        this.socket.on(SocketEvents.PlayerDisconnect, (playerId: string) => {
            const registry = this.playerRegistry[playerId];
            if (registry) {
                registry.player.destroy(true);
                delete this.playerRegistry[playerId]
            }
        });
    }

    private makeMaps(scene: Phaser.Scene) {
        // Background
        this.backgroundMap = BombGame.makeDefaultTileMap(
            scene,
            MAPS.BACKGROUND,
            MAIN_TILES
        );

        // Walls
        this.wallsMap = BombGame.makeDefaultTileMap(scene, MAPS.WALLS, MAIN_TILES);
        this.wallsMap.map.setCollisionBetween(0, 2);

        // Breakables
        this.breakableMap = BombGame.makeDefaultTileMap(scene, MAPS.BREAKABLES, MAIN_TILES);
        this.breakableMap.map.setCollisionBetween(0, 2);
    }

    private fabricPlayer(
        scene: Phaser.Scene,
        directions: PlayerDirections,
        collisions: Array<Phaser.GameObjects.GameObject>
    ): Phaser.Physics.Arcade.Sprite {
        const player = scene.physics.add.sprite(
            directions.x,
            directions.y,
            ASSETS.PLAYER,
            1
        );

        player.setBounce(1.2);
        player.setCollideWorldBounds(true);

        collisions.forEach(layer => {
            scene.physics.add.collider(player, layer, (_, item) => {
                const t = item as any;
                this.breakableMap.map.removeTileAt(t.x, t.y)
            });
        });

        // Make the collision height smaller

        const radius = GameDimensions.tileWidth / 4;
        player.body.setCircle(
            radius,
            (GameDimensions.playerWidth - (radius * 2)) / 2,
            (GameDimensions.playerHeight - (radius * 2)),
        );

        return player
    }

    private create(scene: Phaser.Scene) {
        this.makeMaps(scene);

        const playerCollisions = [
            this.breakableMap,
            this.wallsMap
        ].map(it => it.layer);

        this.socket.emit(SocketEvents.NewPlayer);
        this.socket.on(SocketEvents.StateUpdate, (backState: BackendState) => {
            for (const [id, data] of Object.entries(backState.playerRegistry)) {
                const {playerRegistry} = this;
                if (!(id in playerRegistry)) {
                    playerRegistry[id] = {
                        directions: data.directions,
                        player: this.fabricPlayer(
                            scene,
                            data.directions,
                            playerCollisions
                        )
                    }
                } else {
                    if (this.socket.id !== id) {
                        playerRegistry[id].directions = data.directions
                    }
                }
            }
        });

        scene.anims.create({
            key: 'left',
            frames: scene.anims.generateFrameNumbers(ASSETS.PLAYER, {
                start: 0,
                end: 3
            }),
            frameRate: 10,
            repeat: -1
        });

        scene.anims.create({
            key: 'turn',
            frames: [{
                key: ASSETS.PLAYER,
                frame: 4
            }],
            frameRate: 20
        });

        scene.anims.create({
            key: 'right',
            frames: scene.anims.generateFrameNumbers(ASSETS.PLAYER, {
                start: 5,
                end: 8
            }),
            frameRate: 10,
            repeat: -1
        });
    }

    private update(scene: Phaser.Scene) {
        for (const [id, registry] of Object.entries(this.playerRegistry)) {
            const {player, directions} = registry;

            if (this.socket.id === id) {
                const cursors = scene.input.keyboard.createCursorKeys();
                Object.assign(directions, {
                    left: cursors.left!.isDown,
                    right: cursors.right!.isDown,
                    down: cursors.up!.isDown,
                    up: cursors.down!.isDown,
                    x: player.x,
                    y: player.y
                });
                BombGame.applyPhysicsAndAnimations(player, directions)
            } else {
                // Fixes some position imprecision (from player animations)
                const tolerance = 10;
                const isXOk = inRange({
                    min: directions.x - tolerance,
                    max: directions.x + tolerance,
                    value: player.x
                });
                const isYOk = inRange({
                    min: directions.y - tolerance,
                    max: directions.y + tolerance,
                    value: player.y
                });


                if (!isXOk || !isYOk) {
                    player.x = directions.x;
                    player.y = directions.y
                } else {
                    BombGame.applyPhysicsAndAnimations(player, directions)
                }
            }
        }


        // Update server
        const player = this.playerRegistry[this.socket.id];
        if (player) {
            this.socket.emit(SocketEvents.Movement, player.directions);
        }
    }

}
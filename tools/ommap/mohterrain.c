/*
===========================================================================
MoHAA's terrain: MOHRadiant's terrainDef blocks read from the .map and written as the
game's terrain patches (LUMP_TERRAIN), each world leaf listing the patches it reaches
(LUMP_TERRAININDEXES). The light step gives them their lightmaps (TerrainLightmaps).

A terrainDef is W x H vertices 64 units apart (W and H 8k+1), an origin, one texture
line per patch corner and per vertex a height (from the origin) and two flag groups,
one per triangle of the square that vertex starts; "nodraw" in a group cuts that
triangle away. The game's patch is 9 x 9 heights in 2-unit steps above a base height,
read by the renderer and the collision code (renderergl1/tr_bsp.c R_UnpackTerraPatch,
qcommon/cm_terrain.c); the field meanings below are theirs.

This file is part of ommap, under the GNU General Public License, version 2 or later.
===========================================================================
*/

#include "qbsp.h"

#define MAX_TERRAIN_BLOCKS		1024

typedef struct {
	char	tex[MAX_QPATH];
	float	shift[2], rotate, width, scale[2];
	int		contents, flags;
} terrainCorner_t;

typedef struct {
	int				w, h, flags;
	vec3_t			origin;
	int				numCorners;
	terrainCorner_t	*corners;
	float			*heights;		// w * h, x fastest
	byte			*holes;			// w * h, per triangle (first << 0, second << 1):
									// 1 a hole (nodraw or invisible), 4 maxdetail,
									// 16 a nodraw hole, which the land round it is split to meet
	byte			*tdetail;		// w * h, per triangle (<< 0 / << 1): 1 nodetail, 4 important,
									// 16 trivial (EA's other terrain face words)
} terrainBlock_t;

static terrainBlock_t	terrainBlocks[MAX_TERRAIN_BLOCKS];
static int				numTerrainBlocks;

static vec3_t	patchMins[MAX_TERRAIN_PATCHES], patchMaxs[MAX_TERRAIN_PATCHES];


static void ExpectToken( const char *want ) {
	GetToken( qtrue );
	if ( strcmp( token, want ) ) {
		Error( "terrainDef at line %i: expected '%s', found '%s'", scriptline, want, token );
	}
}

/*
================
ParseTerrainDef

After "terrainDef"; reads through the primitive's closing brace.
================
*/
void ParseTerrainDef( void ) {
	terrainBlock_t	*b;
	int				i, n, k;

	if ( numTerrainBlocks >= MAX_TERRAIN_BLOCKS ) {
		Error( "MAX_TERRAIN_BLOCKS (%i)", MAX_TERRAIN_BLOCKS );
	}
	b = &terrainBlocks[numTerrainBlocks];
	memset( b, 0, sizeof( *b ) );

	ExpectToken( "{" );
	GetToken( qtrue ); b->w = atoi( token );
	GetToken( qfalse ); b->h = atoi( token );
	GetToken( qfalse ); b->flags = atoi( token );
	if ( b->w < 9 || b->h < 9 || ( b->w - 1 ) % 8 || ( b->h - 1 ) % 8 || b->w > 1025 || b->h > 1025 ) {
		Error( "terrainDef at line %i: %i x %i vertices (each way 9, 17, 25 ...)", scriptline, b->w, b->h );
	}
	for ( i = 0 ; i < 3 ; i++ ) {
		GetToken( i == 0 );
		b->origin[i] = atof( token );
	}

	// the texture lines, one per patch corner
	n = ( ( b->w - 1 ) / 8 + 1 ) * ( ( b->h - 1 ) / 8 + 1 );
	b->corners = calloc( n, sizeof( terrainCorner_t ) );
	ExpectToken( "{" );
	while ( 1 ) {
		terrainCorner_t	c;
		float			v[9];
		int				nv = 0;

		GetToken( qtrue );
		if ( !strcmp( token, "}" ) ) {
			break;
		}
		// two numbers, then ( texture numbers... )
		GetToken( qfalse );
		ExpectToken( "(" );
		GetToken( qfalse );
		memset( &c, 0, sizeof( c ) );
		strncpy( c.tex, token, sizeof( c.tex ) - 1 );
		while ( 1 ) {
			GetToken( qfalse );
			if ( !strcmp( token, ")" ) ) {
				break;
			}
			if ( nv < 9 ) {
				v[nv++] = atof( token );
			}
		}
		c.shift[0] = nv > 0 ? v[0] : 0;
		c.shift[1] = nv > 1 ? v[1] : 0;
		c.rotate = nv > 2 ? v[2] : 0;
		c.width = nv > 3 && v[3] > 0 ? v[3] : 256;
		c.scale[0] = nv > 4 && v[4] ? v[4] : 1;
		c.scale[1] = nv > 5 && v[5] ? v[5] : 1;
		c.contents = nv > 6 ? (int)v[6] : 0;
		c.flags = nv > 7 ? (int)v[7] : 0;
		if ( b->numCorners < n ) {
			b->corners[b->numCorners++] = c;
		}
	}
	if ( !b->numCorners ) {
		Error( "terrainDef at line %i has no texture lines", scriptline );
	}
	for ( k = b->numCorners ; k < n ; k++ ) {
		b->corners[k] = b->corners[b->numCorners - 1];
	}
	b->numCorners = n;

	// the heights, each with its two flag groups
	n = b->w * b->h;
	b->heights = calloc( n, sizeof( float ) );
	b->holes = calloc( n, 1 );
	b->tdetail = calloc( n, 1 );
	ExpectToken( "{" );
	for ( k = 0 ; ; k++ ) {
		int group = 0;

		GetToken( qtrue );
		if ( !strcmp( token, "}" ) ) {
			break;
		}
		if ( k < n ) {
			b->heights[k] = atof( token );
		}
		while ( TokenAvailable() ) {
			GetToken( qfalse );
			if ( strcmp( token, "(" ) ) {
				UnGetToken();
				break;
			}
			while ( 1 ) {
				GetToken( qfalse );
				if ( !strcmp( token, ")" ) ) {
					break;
				}
				if ( k < n && group < 2 ) {
					if ( !Q_stricmp( token, "nodraw" ) ) {
						b->holes[k] |= 17 << group;
					} else if ( !Q_stricmp( token, "invisible" ) ) {
						b->holes[k] |= 1 << group;
					} else if ( !Q_stricmp( token, "maxdetail" ) ) {
						b->holes[k] |= 4 << group;
					} else if ( !Q_stricmp( token, "nodetail" ) ) {
						b->tdetail[k] |= 1 << group;
					} else if ( !Q_stricmp( token, "important" ) ) {
						b->tdetail[k] |= 4 << group;
					} else if ( !Q_stricmp( token, "trivial" ) ) {
						b->tdetail[k] |= 16 << group;
					}
				}
			}
			group++;
		}
	}
	if ( k != n ) {
		Error( "terrainDef at line %i has %i heights for %i x %i vertices", scriptline, k, b->w, b->h );
	}
	ExpectToken( "}" );		// the terrainDef's
	ExpectToken( "}" );		// the primitive's
	numTerrainBlocks++;
}

/*
================
The variance trees

Each patch is two right triangles, each split in halves six times over: node n's
children are 2n+1 and 2n+2 (0-based), 63 nodes. A node's 16 bits: its variance (the
largest height error, in heightmap steps, below it) in the low 11, then 0x1000 / 0x2000
cutting away its second / first child (a hole), 0x8000 making the renderer split it
whatever its variance (and fixing the new point at its true height). The layout
of the trees and of the hole bits follows qcommon/cm_terrain.c
(CM_CalculateTerrainIndices).
================
*/
typedef struct {
	int		node;		// 0..62
	int		tree;		// 0 / 1
	int		mask;		// 0x1000 / 0x2000
} vni_t;

static vni_t	vniTable[2][8][8][2];
static int		vniMade;

static void CalcVni( const int start[6], int diag, int tree ) {
	int		wn[64][6];
	int		i, k, i2, j2;

	for ( k = 0 ; k < 6 ; k++ ) {
		wn[1][k] = start[k];
	}
	for ( i = 0 ; i < 31 ; i++ ) {
		int *a = wn[i + 1];
		i2 = a[0] + a[2];
		j2 = a[1] + a[3];
		wn[i * 2 + 2][0] = a[2]; wn[i * 2 + 2][1] = a[3]; wn[i * 2 + 2][2] = a[4]; wn[i * 2 + 2][3] = a[5];
		wn[i * 2 + 2][4] = i2 >> 1; wn[i * 2 + 2][5] = j2 >> 1;
		wn[i * 2 + 3][0] = a[4]; wn[i * 2 + 3][1] = a[5]; wn[i * 2 + 3][2] = a[0]; wn[i * 2 + 3][3] = a[1];
		wn[i * 2 + 3][4] = i2 >> 1; wn[i * 2 + 3][5] = j2 >> 1;
	}
#define PUT( ii, jj, slot, m ) \
	if ( (ii) >= 0 && (ii) < 8 && (jj) >= 0 && (jj) < 8 ) { \
		vniTable[diag][ii][jj][slot].node = i - 1; \
		vniTable[diag][ii][jj][slot].tree = tree; \
		vniTable[diag][ii][jj][slot].mask = (m); }
	for ( i = 32 ; i < 64 ; i++ ) {
		int *a = wn[i];
		i2 = ( a[0] + a[2] ) >> 1;
		j2 = ( a[1] + a[3] ) >> 1;
		if ( a[0] == a[2] ) {
			if ( a[1] <= a[3] ) {
				PUT( i2, j2, 1, 0x2000 );
				PUT( i2, j2 - 1, 0, 0x1000 );
			} else {
				PUT( i2 - 1, j2, 1, 0x1000 );
				PUT( i2 - 1, j2 - 1, 0, 0x2000 );
			}
		} else {
			if ( a[0] <= a[2] ) {
				PUT( i2, j2 - 1, 0, 0x2000 );
				PUT( i2 - 1, j2 - 1, 0, 0x1000 );
			} else {
				PUT( i2, j2, 1, 0x1000 );
				PUT( i2 - 1, j2, 1, 0x2000 );
			}
		}
	}
#undef PUT
}

static void MakeVni( void ) {
	static const int s00[6] = { 8, 8, 0, 0, 0, 8 }, s01[6] = { 0, 0, 8, 8, 8, 0 };
	static const int s10[6] = { 8, 0, 0, 8, 8, 8 }, s11[6] = { 0, 8, 8, 0, 0, 0 };

	memset( vniTable, 0, sizeof( vniTable ) );
	CalcVni( s00, 0, 0 );
	CalcVni( s01, 0, 1 );
	CalcVni( s10, 1, 0 );
	CalcVni( s11, 1, 1 );
	vniMade = 1;
}

// the variance of node n (1-based) of the tree from start, and the nodes below it: how far
// the triangle's apex sits from the mean of its long edge's ends, the largest in the subtree.
// This is the measure the game's maps carry, node for node.
static int Variance( const byte *hm, int tri[64][6], int n, unsigned short *out, const byte *adj ) {
	int		*a = tri[n];
	int		v = abs( 2 * hm[a[5] * 9 + a[4]] - hm[a[1] * 9 + a[0]] - hm[a[3] * 9 + a[2]] );

	if ( 2 * n < 64 ) {
		int l = Variance( hm, tri, 2 * n, out, adj ), r = Variance( hm, tri, 2 * n + 1, out, adj );
		if ( l > v ) v = l;
		if ( r > v ) v = r;
	} else if ( adj && adj[n - 1] == 1 ) {
		v *= 2;					// EA's "important": a deepest node splits sooner
	} else if ( adj && adj[n - 1] == 2 ) {
		v = ( v + 1 ) / 2;		// EA's "trivial": later
	}
	if ( v > 0x7ff ) {
		v = 0x7ff;
	}
	out[n - 1] = ( out[n - 1] & ~0x7ff ) | v;
	return v;
}

static void VarianceTree( const byte *hm, const int start[6], unsigned short *out, const byte *adj ) {
	int		tri[64][6];
	int		i, k;

	for ( k = 0 ; k < 6 ; k++ ) {
		tri[1][k] = start[k];
	}
	for ( i = 1 ; i < 32 ; i++ ) {
		int *a = tri[i];
		int mi = ( a[0] + a[2] ) >> 1, mj = ( a[1] + a[3] ) >> 1;
		tri[2 * i][0] = a[2]; tri[2 * i][1] = a[3]; tri[2 * i][2] = a[4]; tri[2 * i][3] = a[5]; tri[2 * i][4] = mi; tri[2 * i][5] = mj;
		tri[2 * i + 1][0] = a[4]; tri[2 * i + 1][1] = a[5]; tri[2 * i + 1][2] = a[0]; tri[2 * i + 1][3] = a[1]; tri[2 * i + 1][4] = mi; tri[2 * i + 1][5] = mj;
	}
	Variance( hm, tri, 1, out, adj );
}

/*
================
TerrainHoleFlags

What EA's compiler writes beside the holes, as the game's maps have it:
- a node above the deepest level carries 0x2000 when its first child's triangles are all
  holes and 0x1000 when its second child's are (the deepest nodes' own two bits are the
  holes themselves, set above);
- 0x8000 (split this node, whatever its variance) on the way down to every triangle that
  must be drawn at full detail: each nodraw hole, each maxdetail triangle, each triangle
  sharing an edge with a nodraw hole and the triangle across that one's long edge. Each
  node so split also splits the node across its own long edge, in its patch or the patch
  beside it on the 512-unit grid. Invisible holes are cut but split nothing.
This matches the game's mohdm6 and m4l0 node for node, holes and variance exactly, the
0x8000s to better than 99%.
================
*/
static const int terStarts[2][2][6] = {
	{ { 8, 8, 0, 0, 0, 8 }, { 0, 0, 8, 8, 8, 0 } },
	{ { 8, 0, 0, 8, 8, 8 }, { 0, 8, 8, 0, 0, 0 } } };

static void TerrainTris( int diag, int tree, int tri[128][6] ) {
	int		i, k;

	for ( k = 0 ; k < 6 ; k++ ) {
		tri[1][k] = terStarts[diag][tree][k];
	}
	for ( i = 1 ; i < 64 ; i++ ) {
		int *a = tri[i];
		int mi = ( a[0] + a[2] ) >> 1, mj = ( a[1] + a[3] ) >> 1;
		tri[2 * i][0] = a[2]; tri[2 * i][1] = a[3]; tri[2 * i][2] = a[4]; tri[2 * i][3] = a[5]; tri[2 * i][4] = mi; tri[2 * i][5] = mj;
		tri[2 * i + 1][0] = a[4]; tri[2 * i + 1][1] = a[5]; tri[2 * i + 1][2] = a[0]; tri[2 * i + 1][3] = a[1]; tri[2 * i + 1][4] = mi; tri[2 * i + 1][5] = mj;
	}
}

// per patch, as hole bits on the deepest nodes: the nodraw holes and the maxdetail triangles
static unsigned short	terCut[MAX_TERRAIN_PATCHES][2][63];
static unsigned short	terDetail[MAX_TERRAIN_PATCHES][2][63];

static int		terTri[2][2][128][6];		// [diag][tree][node 1..127]: the triangles, patch units
static int		terGrid[256][256];			// patch index + 1 by its x, y; 0 for none

// whether triangle a has corners p and q (patch units)
static qboolean TerHasCorner( const int *a, int x, int y ) {
	return ( a[0] == x && a[1] == y ) || ( a[2] == x && a[3] == y ) || ( a[4] == x && a[5] == y );
}

// the patch whose grid holds point (x, y) of patch n, beside n on the 512-unit grid (n
// itself for a point inside it); -1 for none. *ox, *oy: the point in that patch's units.
// A point on a shared edge is first looked for in n.
static int TerPatchFor( int n, int x, int y, int dx, int dy, int *ox, int *oy ) {
	cTerraPatch_t	*p = (cTerraPatch_t *)&terraPatches[n];
	int				px = p->x + dx * 8, py = p->y + dy * 8, g;

	*ox = x - dx * 8;
	*oy = y - dy * 8;
	if ( !dx && !dy ) {
		return n;
	}
	if ( px < -128 || px > 127 || py < -128 || py > 127 ) {
		return -1;
	}
	g = terGrid[px + 128][py + 128] - 1;
	return g;
}

// a node at the depth given whose long edge is the segment (x0 y0)-(x1 y1), in patch m,
// other than skip; 0 for none, else tree * 128 + node
static int TerNodeByEdge( int m, int depth, int x0, int y0, int x1, int y1, int skip ) {
	cTerraPatch_t	*q = (cTerraPatch_t *)&terraPatches[m];
	int				diag = ( q->flags & TERPATCH_NEIGHBOR ) ? 1 : 0, t, i;

	for ( t = 0 ; t < 2 ; t++ ) {
		for ( i = 1 << depth ; i < 2 << depth ; i++ ) {
			const int *a = terTri[diag][t][i];
			if ( t * 128 + i == skip ) {
				continue;
			}
			if ( ( a[0] == x0 && a[1] == y0 && a[2] == x1 && a[3] == y1 ) ||
				 ( a[0] == x1 && a[1] == y1 && a[2] == x0 && a[3] == y0 ) ) {
				return t * 128 + i;
			}
		}
	}
	return 0;
}

// the other triangles at depth sharing node (t, i) of patch n's long edge, in n and the
// patches on the grid beside it, are put in out (patch, tree * 128 + node); their count
static int TerAcross( int n, int t, int i, int out[4][2] ) {
	cTerraPatch_t	*p = (cTerraPatch_t *)&terraPatches[n];
	int				diag = ( p->flags & TERPATCH_NEIGHBOR ) ? 1 : 0;
	const int		*a = terTri[diag][t][i];
	int				depth = 0, dx, dy, num = 0;

	while ( ( 2 << depth ) <= i ) {
		depth++;
	}
	for ( dx = -1 ; dx <= 1 ; dx++ ) {
		for ( dy = -1 ; dy <= 1 ; dy++ ) {
			int m, ox0, oy0, ox1, oy1, r;
			if ( dx && dy ) {
				continue;
			}
			m = TerPatchFor( n, a[0], a[1], dx, dy, &ox0, &oy0 );
			if ( m < 0 ) {
				continue;
			}
			TerPatchFor( n, a[2], a[3], dx, dy, &ox1, &oy1 );
			if ( ox0 < 0 || ox0 > 8 || oy0 < 0 || oy0 > 8 || ox1 < 0 || ox1 > 8 || oy1 < 0 || oy1 > 8 ) {
				continue;
			}
			r = TerNodeByEdge( m, depth, ox0, oy0, ox1, oy1, m == n ? t * 128 + i : 0 );
			if ( r && num < 4 ) {
				out[num][0] = m;
				out[num][1] = r;
				num++;
			}
		}
	}
	return num;
}

// the triangles sharing an edge with leaf (t, i) of patch n, by the same rule
static int TerLeafNeighbours( int n, int t, int i, int out[8][2] ) {
	cTerraPatch_t	*p = (cTerraPatch_t *)&terraPatches[n];
	int				diag = ( p->flags & TERPATCH_NEIGHBOR ) ? 1 : 0;
	const int		*a = terTri[diag][t][i];
	int				e, num = 0;

	for ( e = 0 ; e < 3 ; e++ ) {
		int x0 = a[e * 2], y0 = a[e * 2 + 1], x1 = a[( e * 2 + 2 ) % 6], y1 = a[( e * 2 + 3 ) % 6];
		int dx, dy;
		for ( dx = -1 ; dx <= 1 ; dx++ ) {
			for ( dy = -1 ; dy <= 1 ; dy++ ) {
				int m, ox0, oy0, ox1, oy1, tt, j, qd;
				cTerraPatch_t *q;
				if ( dx && dy ) {
					continue;
				}
				m = TerPatchFor( n, x0, y0, dx, dy, &ox0, &oy0 );
				if ( m < 0 ) {
					continue;
				}
				TerPatchFor( n, x1, y1, dx, dy, &ox1, &oy1 );
				if ( ox0 < 0 || ox0 > 8 || oy0 < 0 || oy0 > 8 || ox1 < 0 || ox1 > 8 || oy1 < 0 || oy1 > 8 ) {
					continue;
				}
				q = (cTerraPatch_t *)&terraPatches[m];
				qd = ( q->flags & TERPATCH_NEIGHBOR ) ? 1 : 0;
				for ( tt = 0 ; tt < 2 ; tt++ ) {
					for ( j = 64 ; j < 128 ; j++ ) {
						const int *b = terTri[qd][tt][j];
						if ( m == n && tt == t && j == i ) {
							continue;
						}
						if ( TerHasCorner( b, ox0, oy0 ) && TerHasCorner( b, ox1, oy1 ) && num < 8 ) {
							out[num][0] = m;
							out[num][1] = tt * 128 + j;
							num++;
						}
					}
				}
			}
		}
	}
	return num;
}

static void TerrainHoleFlags( void ) {
	byte	*seed, *anc;
	int		n, t, i, k, j;

	for ( k = 0 ; k < 4 ; k++ ) {
		TerrainTris( k >> 1, k & 1, terTri[k >> 1][k & 1] );
	}
	memset( terGrid, 0, sizeof( terGrid ) );
	for ( n = numTerraPatches - 1 ; n >= 0 ; n-- ) {
		cTerraPatch_t *p = (cTerraPatch_t *)&terraPatches[n];
		terGrid[p->x + 128][p->y + 128] = n + 1;
	}

	// pass full holes up the tree
	for ( n = 0 ; n < numTerraPatches ; n++ ) {
		cTerraPatch_t	*p = (cTerraPatch_t *)&terraPatches[n];
		for ( t = 0 ; t < 2 ; t++ ) {
			unsigned short *vt = (unsigned short *)p->varTree[t];
			for ( i = 30 ; i >= 0 ; i-- ) {
				if ( ( vt[2 * i + 1] & 0x3000 ) == 0x3000 ) vt[i] |= 0x2000;
				if ( ( vt[2 * i + 2] & 0x3000 ) == 0x3000 ) vt[i] |= 0x1000;
			}
		}
	}

	// the leaves (nodes 64..127 of each tree) to reach at full detail
	seed = calloc( numTerraPatches * 256, 1 );
	anc = calloc( numTerraPatches * 256, 1 );
	for ( n = 0 ; n < numTerraPatches ; n++ ) {
		for ( t = 0 ; t < 2 ; t++ ) {
			for ( i = 31 ; i < 63 ; i++ ) {
				for ( k = 0 ; k < 2 ; k++ ) {
					int mask = k ? 0x1000 : 0x2000, leaf = t * 128 + 2 * ( i + 1 ) + k;
					if ( terDetail[n][t][i] & mask ) {
						seed[n * 256 + leaf] = 1;
					}
					if ( terCut[n][t][i] & mask ) {
						int nb[8][2], num, c;
						seed[n * 256 + leaf] = 1;
						num = TerLeafNeighbours( n, t, 2 * ( i + 1 ) + k, nb );
						for ( c = 0 ; c < num ; c++ ) {
							int across[4][2], na, d;
							seed[nb[c][0] * 256 + nb[c][1]] = 1;
							na = TerAcross( nb[c][0], nb[c][1] >> 7, nb[c][1] & 127, across );
							for ( d = 0 ; d < na ; d++ ) {
								seed[across[d][0] * 256 + across[d][1]] = 1;
							}
						}
					}
				}
			}
		}
	}

	// split the way down to each, then each node across from one so split
	for ( n = 0 ; n < numTerraPatches ; n++ ) {
		for ( j = 0 ; j < 256 ; j++ ) {
			if ( seed[n * 256 + j] && ( j & 127 ) >= 64 ) {
				for ( i = ( j & 127 ) >> 1 ; i >= 1 ; i >>= 1 ) {
					anc[n * 256 + ( j & 128 ) + i] = 1;
				}
			}
		}
	}
	for ( n = 0 ; n < numTerraPatches ; n++ ) {
		cTerraPatch_t	*p = (cTerraPatch_t *)&terraPatches[n];
		for ( j = 0 ; j < 256 ; j++ ) {
			int across[4][2], na, d;
			if ( !anc[n * 256 + j] ) {
				continue;
			}
			t = j >> 7;
			i = j & 127;
			( (unsigned short *)p->varTree[t] )[i - 1] |= 0x8000;
			na = TerAcross( n, t, i, across );
			for ( d = 0 ; d < na ; d++ ) {
				cTerraPatch_t *q = (cTerraPatch_t *)&terraPatches[across[d][0]];
				( (unsigned short *)q->varTree[across[d][1] >> 7] )[( across[d][1] & 127 ) - 1] |= 0x8000;
			}
		}
	}
	free( seed );
	free( anc );
}

static qboolean	terOriginSet;
static int		terOx, terOy;

/*
================
EmitTerrain

The blocks as patches: called once the world's shaders may be emitted, before the
world's leaves are written.
================
*/
void EmitTerrain( void ) {
	int			bi, pi, pj, i, j, k, a, n;
	static const int starts[2][2][6] = {
		{ { 8, 8, 0, 0, 0, 8 }, { 0, 0, 8, 8, 8, 0 } },
		{ { 8, 0, 0, 8, 8, 8 }, { 0, 8, 8, 0, 0, 0 } } };

	if ( !vniMade ) {
		MakeVni();
	}
	numTerraPatches = 0;
	numTerrainIndexes = 0;
	for ( bi = 0 ; bi < numTerrainBlocks ; bi++ ) {
		terrainBlock_t	*b = &terrainBlocks[bi];
		int				nx = ( b->w - 1 ) / 8, ny = ( b->h - 1 ) / 8;

		if ( fmod( b->origin[0], 64 ) || fmod( b->origin[1], 64 ) ) {
			Error( "terrain at %.0f %.0f: x and y must be on the 64-unit grid", b->origin[0], b->origin[1] );
		}
		for ( pj = 0 ; pj < ny ; pj++ ) {
			for ( pi = 0 ; pi < nx ; pi++ ) {
				cTerraPatch_t	*p;
				terrainCorner_t	*c;
				float			lo = 1e30f, hi = -1e30f, rx, ry;
				int				px, py, base;
				char			name[MAX_QPATH + 16];

				if ( numTerraPatches >= MAX_TERRAIN_PATCHES ) {
					Error( "MAX_TERRAIN_PATCHES (%i)", MAX_TERRAIN_PATCHES );
				}
				p = (cTerraPatch_t *)&terraPatches[numTerraPatches];
				memset( p, 0, sizeof( *p ) );

				px = (int)( b->origin[0] / 64 ) + pi * 8;
				py = (int)( b->origin[1] / 64 ) + pj * 8;
				if ( px < -128 || px > 127 || py < -128 || py > 127 ) {
					Error( "terrain patch at %i %i is past the .bsp's limit of -8192 to 8128", px * 64, py * 64 );
				}
				p->x = (signed char)px;
				p->y = (signed char)py;

				// heights: 2-unit steps above the patch's lowest point
				for ( j = 0 ; j < 9 ; j++ ) {
					for ( i = 0 ; i < 9 ; i++ ) {
						float h = b->heights[( pj * 8 + j ) * b->w + pi * 8 + i];
						if ( h < lo ) lo = h;
						if ( h > hi ) hi = h;
					}
				}
				base = (int)floor( b->origin[2] + lo );
				if ( base < -32768 || base > 32767 ) {
					Error( "terrain patch at %i %i is too high or low for the .bsp", px * 64, py * 64 );
				}
				if ( hi - lo > 510 ) {
					_printf( "WARNING: terrain patch at %i %i spans %.0f units in height; the .bsp holds 510\n", px * 64, py * 64, hi - lo );
				}
				p->iBaseHeight = (short)base;
				for ( j = 0 ; j < 9 ; j++ ) {
					for ( i = 0 ; i < 9 ; i++ ) {
						float h = b->origin[2] + b->heights[( pj * 8 + j ) * b->w + pi * 8 + i] - base;
						int v = (int)floor( h / 2 + 0.5f );
						p->heightmap[j * 9 + i] = v < 0 ? 0 : ( v > 255 ? 255 : v );
					}
				}

				// the patch's texture line (its lowest corner's) and texture coordinates
				// at its four corners, measured from the block's origin
				c = &b->corners[pj * ( nx + 1 ) + pi];
				sprintf( name, "textures/%s", c->tex );
				p->iShader = EmitShader( name );
				// terrain records name no fence mask, as EA's do
				strcpy( dshaders[p->iShader].fenceMaskImage, "nomask" );
				dshaders[p->iShader].surfaceFlags |= c->flags;
				dshaders[p->iShader].contentFlags |= c->contents;
				for ( i = 0 ; i < 2 ; i++ ) {
					for ( j = 0 ; j < 2 ; j++ ) {
						// as a floor brush face's texture (TextureAxisFromPlane's s = x,
						// t = -y, then turned, then the shift added): EA's compiler turns and
						// shifts terrain textures that way (m4l0's 90-degree furrows and
						// m3l1b's shifted grass match the game's .bsp only so; the turn and
						// the t shift had the other sign here). A right angle turns exactly: cos(270) as -4e-8 put a corner's t
						// at -1e-8, the game's floor() then moved the whole patch past the
						// edge of a clamped texture (the long colour bars on m3l1b's cliffs)
						double	r = -c->rotate * Q_PI / 180.0, cs = cos( r ), sn = sin( r );
						double	u, w;
						if ( fabs( cs ) < 1e-6 ) cs = 0;
						if ( fabs( sn ) < 1e-6 ) sn = 0;
						rx = ( pi + i ) * 512.0f;
						ry = ( pj + j ) * 512.0f;
						u = rx * cs - ry * sn;
						w = rx * sn + ry * cs;
						p->texCoord[i][j][0] = (float)( ( u + c->shift[0] ) / ( c->width * c->scale[0] ) );
						p->texCoord[i][j][1] = (float)( ( c->shift[1] - w ) / ( c->width * c->scale[1] ) );
					}
				}

				// the triangles' diagonals alternate patch by patch across the whole map,
				// as in EA's maps: a patch's neighbours always have the other diagonal.
				// (Counted from the map's first patch, not from each terrainDef: a
				// decompiled map has one terrainDef a patch, and with every patch the
				// same way the renderer's split chains across patches never ended,
				// freezing the game as soon as the terrain came into view.)
				if ( !terOriginSet ) {
					terOriginSet = qtrue;
					terOx = px;
					terOy = py;
				}
				if ( ( ( ( px - terOx ) >> 3 ) + ( ( py - terOy ) >> 3 ) ) & 1 ) {
					p->flags |= TERPATCH_NEIGHBOR;
				}
				if ( b->flags & 1 ) {
					p->flags |= TERPATCH_FLIP;
				}
				p->lmapScale = 2;		// a lightmap texel every 32 units, as in the game's maps
				p->iNorth = p->iEast = p->iSouth = p->iWest = -1;

				// variance, then the holes and the splits that reach them
				unsigned short	nodet[2][63], ndraw[2][63];		// the deepest nodes' nodetail / nodraw children
				{
					int diag = ( p->flags & TERPATCH_NEIGHBOR ) ? 1 : 0;
					unsigned short *vt0 = (unsigned short *)p->varTree[0], *vt1 = (unsigned short *)p->varTree[1];

					byte	adj[2][63];

					// each deepest node's important (1) / trivial (2), from its triangles
					memset( adj, 0, sizeof( adj ) );
					for ( i = 0 ; i < 8 ; i++ ) {
						for ( j = 0 ; j < 8 ; j++ ) {
							byte td = b->tdetail[( pj * 8 + j ) * b->w + pi * 8 + i];
							for ( k = 0 ; k < 2 ; k++ ) {
								int		tri = ( ( i + j ) & 1 ) ? k : 1 - k;
								vni_t	*v = &vniTable[diag][i][j][k];
								if ( !v->mask ) {
									continue;
								}
								if ( td & ( 4 << tri ) ) {
									adj[v->tree][v->node] = 1;
								} else if ( ( td & ( 16 << tri ) ) && adj[v->tree][v->node] != 1 ) {
									adj[v->tree][v->node] = 2;
								}
							}
						}
					}
					VarianceTree( p->heightmap, starts[diag][0], vt0, adj[0] );
					VarianceTree( p->heightmap, starts[diag][1], vt1, adj[1] );
					memset( nodet, 0, sizeof( nodet ) );
					memset( ndraw, 0, sizeof( ndraw ) );
					for ( i = 0 ; i < 8 ; i++ ) {
						for ( j = 0 ; j < 8 ; j++ ) {
							byte hole = b->holes[( pj * 8 + j ) * b->w + pi * 8 + i];
							for ( k = 0 ; k < 2 ; k++ ) {
								// slot 0 is the collision code's first triangle: the +x one
								// on odd squares, the -x one on even ones
								int		tri = ( ( i + j ) & 1 ) ? k : 1 - k;
								vni_t	*v = &vniTable[diag][i][j][k];
								unsigned short	*vt;
								if ( !v->mask ) {
									continue;
								}
								if ( hole & ( 4 << tri ) ) {
									terDetail[numTerraPatches][v->tree][v->node] |= v->mask;
								}
								if ( hole & ( 16 << tri ) ) {
									terCut[numTerraPatches][v->tree][v->node] |= v->mask;
									ndraw[v->tree][v->node] |= v->mask;
								}
								if ( b->tdetail[( pj * 8 + j ) * b->w + pi * 8 + i] & ( 1 << tri ) ) {
									nodet[v->tree][v->node] |= v->mask;
								}
								if ( !( hole & ( 1 << tri ) ) ) {
									continue;
								}
								vt = v->tree ? vt1 : vt0;
								vt[v->node] |= v->mask;
							}
						}
					}
				}

				// EA's "nodetail": a deepest node both of whose triangles are nodetail (and
				// neither a nodraw hole) is never split (0x4000), so steep land keeps its
				// big triangles and their texture isn't drawn out into stripes; a node is
				// never split when both its children aren't, and nothing under it is
				{
					unsigned short	*vt[2] = { (unsigned short *)p->varTree[0], (unsigned short *)p->varTree[1] };
					int				t2, n2;
					for ( t2 = 0 ; t2 < 2 ; t2++ ) {
						for ( n2 = 31 ; n2 < 63 ; n2++ ) {
							if ( nodet[t2][n2] == 0x3000 && !ndraw[t2][n2] ) {
								vt[t2][n2] |= 0x4000;
							}
						}
						for ( n2 = 31 ; n2 >= 1 ; n2-- ) {		// heap node n2, children 2n2 and 2n2+1
							if ( vt[t2][2 * n2 - 1] & vt[t2][2 * n2] & 0x4000 ) {
								vt[t2][n2 - 1] |= 0x4000;
							}
						}
						for ( n2 = 2 ; n2 < 64 ; n2++ ) {
							if ( vt[t2][n2 / 2 - 1] & 0x4000 ) {
								vt[t2][n2 - 1] |= 0x4000;
							}
						}
					}
				}

				patchMins[numTerraPatches][0] = px * 64.0f;
				patchMins[numTerraPatches][1] = py * 64.0f;
				patchMins[numTerraPatches][2] = base;
				patchMaxs[numTerraPatches][0] = px * 64.0f + 512;
				patchMaxs[numTerraPatches][1] = py * 64.0f + 512;
				{
					int top = 0;
					for ( k = 0 ; k < 81 ; k++ ) if ( p->heightmap[k] > top ) top = p->heightmap[k];
					patchMaxs[numTerraPatches][2] = base + 2 * top;
				}
				numTerraPatches++;
			}
		}
	}

	TerrainHoleFlags();

	// neighbours: the patches 512 units north (+y), east (+x), south and west
	for ( i = 0 ; i < numTerraPatches ; i++ ) {
		cTerraPatch_t *p = (cTerraPatch_t *)&terraPatches[i];
		for ( n = 0 ; n < numTerraPatches ; n++ ) {
			cTerraPatch_t *q = (cTerraPatch_t *)&terraPatches[n];
			if ( q->x == p->x && q->y == p->y + 8 ) p->iNorth = n;
			if ( q->x == p->x + 8 && q->y == p->y ) p->iEast = n;
			if ( q->x == p->x && q->y == p->y - 8 ) p->iSouth = n;
			if ( q->x == p->x - 8 && q->y == p->y ) p->iWest = n;
		}
	}
	if ( numTerraPatches ) {
		qprintf( "%5i terrain patches\n", numTerraPatches );
	}
}

/*
================
EmitLeafTerrain

The terrain patches a world leaf reaches, solid leaves too, as EA's compiler lists them: a
patch is listed when the leaf's box meets the box of one of its 128 smallest triangles,
holes counted.
================
*/
void EmitLeafTerrain( dleaf_t *leaf, const vec3_t mins, const vec3_t maxs ) {
	int		i, t, n, c;

	leaf->firstTerraPatch = numTerrainIndexes;
	for ( i = 0 ; i < numTerraPatches ; i++ ) {
		cTerraPatch_t	*p = (cTerraPatch_t *)&terraPatches[i];
		int				diag = ( p->flags & TERPATCH_NEIGHBOR ) ? 1 : 0;
		qboolean		meets = qfalse;

		if ( patchMins[i][0] > maxs[0] || patchMaxs[i][0] < mins[0]
			|| patchMins[i][1] > maxs[1] || patchMaxs[i][1] < mins[1]
			|| patchMins[i][2] > maxs[2] || patchMaxs[i][2] < mins[2] ) {
			continue;
		}
		for ( t = 0 ; t < 2 && !meets ; t++ ) {
			for ( n = 64 ; n < 128 && !meets ; n++ ) {
				const int	*a = terTri[diag][t][n];
				float		lo[3] = { 1e30f, 1e30f, 1e30f }, hi[3] = { -1e30f, -1e30f, -1e30f };
				for ( c = 0 ; c < 3 ; c++ ) {
					float	v[3];
					v[0] = patchMins[i][0] + a[c * 2] * 64.0f;
					v[1] = patchMins[i][1] + a[c * 2 + 1] * 64.0f;
					v[2] = patchMins[i][2] + 2 * p->heightmap[a[c * 2 + 1] * 9 + a[c * 2]];
					int k;
					for ( k = 0 ; k < 3 ; k++ ) {
						if ( v[k] < lo[k] ) lo[k] = v[k];
						if ( v[k] > hi[k] ) hi[k] = v[k];
					}
				}
				if ( lo[0] <= maxs[0] && hi[0] >= mins[0] && lo[1] <= maxs[1] && hi[1] >= mins[1]
					&& lo[2] <= maxs[2] && hi[2] >= mins[2] ) {
					meets = qtrue;
				}
			}
		}
		if ( !meets ) {
			continue;
		}
		if ( numTerrainIndexes >= MAX_TERRAIN_INDEXES ) {
			Error( "MAX_TERRAIN_INDEXES (%i)", MAX_TERRAIN_INDEXES );
		}
		terrainIndexes[numTerrainIndexes++] = i;
	}
	leaf->numTerraPatches = numTerrainIndexes - leaf->firstTerraPatch;
}

/*
================
DropUnseenTerrain

A terrain patch no leaf's box reaches (beyond the world's brushes) is left out, as EA's
compiler leaves such patches out, and the leaf lists and neighbours are renumbered. A patch
cut away entirely is kept if a leaf reaches it, as EA's compiler keeps it.
================
*/
void DropUnseenTerrain( void ) {
	int		i, n, dropped;
	int		remap[MAX_TERRAIN_PATCHES];
	byte	used[MAX_TERRAIN_PATCHES];

	if ( !numTerraPatches ) {
		return;
	}
	memset( used, 0, sizeof( used ) );
	for ( i = 0 ; i < numTerrainIndexes ; i++ ) {
		used[terrainIndexes[i]] = 1;
	}
	n = 0;
	for ( i = 0 ; i < numTerraPatches ; i++ ) {
		remap[i] = used[i] ? n++ : -1;
	}
	dropped = numTerraPatches - n;
	if ( !dropped ) {
		return;
	}
	for ( i = 0 ; i < numTerraPatches ; i++ ) {
		cTerraPatch_t	*p;
		if ( remap[i] < 0 ) {
			continue;
		}
		if ( remap[i] != i ) {
			terraPatches[remap[i]] = terraPatches[i];
			VectorCopy( patchMins[i], patchMins[remap[i]] );
			VectorCopy( patchMaxs[i], patchMaxs[remap[i]] );
		}
		p = (cTerraPatch_t *)&terraPatches[remap[i]];
		p->iNorth = p->iNorth >= 0 ? remap[p->iNorth] : -1;
		p->iEast = p->iEast >= 0 ? remap[p->iEast] : -1;
		p->iSouth = p->iSouth >= 0 ? remap[p->iSouth] : -1;
		p->iWest = p->iWest >= 0 ? remap[p->iWest] : -1;
	}
	for ( i = 0 ; i < numTerrainIndexes ; i++ ) {
		terrainIndexes[i] = remap[terrainIndexes[i]];
	}
	numTerraPatches = n;
	_printf( "%5i terrain patches left out: no leaf reaches them\n", dropped );
}

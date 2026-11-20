/*
===========================================================================
Copyright (C) 1999-2005 Id Software, Inc.

This file is part of Quake III Arena source code.

Quake III Arena source code is free software; you can redistribute it
and/or modify it under the terms of the GNU General Public License as
published by the Free Software Foundation; either version 2 of the License,
or (at your option) any later version.

Quake III Arena source code is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Foobar; if not, write to the Free Software
Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
===========================================================================
*/
#include "qbsp.h"

/*
============
FenceMaskName

The fence mask a shader record names, as EA's compiler writes it: the shader's editor
image, which the game reads for the see-through pixels of a fence (a shot passes where
the image is clear); "ignore" for nodraw, whose sides a shot always passes through; none
for a shader without an editor image.
============
*/
static void FenceMaskName( const shaderInfo_t *si, char *out, int size ) {
	const char	*name = "";

	if ( si && si->editorimage[0] ) {
		name = Q_stricmp( si->editorimage, "textures/common/nodraw.tga" ) ? si->editorimage : "ignore";
	}
	strncpy( out, name, size - 1 );
	out[size - 1] = 0;
}

/*
============
EmitShader
============
*/
int	EmitShader( const char *shader ) {
	int				i;
	shaderInfo_t	*si;

	if ( !shader ) {
		shader = "noshader";
	}

	for ( i = 0 ; i < numShaders ; i++ ) {
		if ( !Q_stricmp( shader, dshaders[i].shader ) ) {
			return i;
		}
	}

	if ( i == MAX_MAP_SHADERS ) {
		Error( "MAX_MAP_SHADERS" );
	}
	numShaders++;
	strcpy( dshaders[i].shader, shader );

	si = ShaderInfoForShader( shader );
	dshaders[i].surfaceFlags = si->surfaceFlags;
	dshaders[i].contentFlags = si->contents;
	FenceMaskName( si, dshaders[i].fenceMaskImage, sizeof( dshaders[i].fenceMaskImage ) );

	return i;
}


/*
============
EmitPlanes

There is no oportunity to discard planes, because all of the original
brushes will be saved in the map.
============
*/
void EmitPlanes (void)
{
	int			i;
	dplane_t	*dp;
	plane_t		*mp;

	mp = mapplanes;
	for (i=0 ; i<nummapplanes ; i++, mp++)
	{
		dp = &dplanes[numplanes];
		VectorCopy ( mp->normal, dp->normal);
		dp->dist = mp->dist;
		numplanes++;
	}
}



/*
==================
EmitLeaf
==================
*/
/*
==================
Static models

MoHAA's static_* entities (props placed in the editor) aren't entities in the game: they
go into the static model lumps (model, origin, angles, scale) and every world leaf they
reach lists them. Their size here is a box of STATIC_MODEL_RADIUS times their scale round
their origin, as the tool doesn't read the models themselves.
==================
*/
#define STATIC_MODEL_RADIUS	64

static vec3_t	staticMins[MAX_STATIC_MODELS], staticMaxs[MAX_STATIC_MODELS];

void CollectStaticModels( void ) {
	int			i, k;
	entity_t	*e;
	const char	*cls, *v;
	dstaticModel_t	*sm;
	float		r;

	numStaticModels = 0;
	numLeafStaticModels = 0;
	for ( i = 1 ; i < num_entities ; i++ ) {
		e = &entities[i];
		if ( !e->epairs ) {
			continue;
		}
		cls = ValueForKey( e, "classname" );
		if ( Q_strncasecmp( cls, "static_", 7 ) ) {
			continue;
		}
		v = ValueForKey( e, "model" );
		if ( !v[0] ) {
			_printf( "WARNING: entity %i (%s) has no model: left as an entity\n", i, cls );
			continue;
		}
		if ( numStaticModels >= MAX_STATIC_MODELS ) {
			Error( "MAX_STATIC_MODELS (%i)", MAX_STATIC_MODELS );
		}
		sm = &staticModels[numStaticModels];
		memset( sm, 0, sizeof( *sm ) );
		strncpy( sm->model, v, sizeof( sm->model ) - 1 );
		GetVectorForKey( e, "origin", sm->origin );
		if ( ValueForKey( e, "angles" )[0] ) {
			GetVectorForKey( e, "angles", sm->angles );
		} else {
			sm->angles[1] = FloatForKey( e, "angle" );
		}
		sm->scale = ValueForKey( e, "scale" )[0] ? FloatForKey( e, "scale" ) : 1.0f;
		r = STATIC_MODEL_RADIUS * ( sm->scale > 0 ? sm->scale : 1.0f );
		for ( k = 0 ; k < 3 ; k++ ) {
			staticMins[numStaticModels][k] = sm->origin[k] - r;
			staticMaxs[numStaticModels][k] = sm->origin[k] + r;
		}
		numStaticModels++;
		e->epairs = NULL;	// not an entity in the game
	}
	qprintf( "%5i static models\n", numStaticModels );
}

void EmitLeaf (node_t *node)
{
	dleaf_t				*leaf_p;
	bspbrush_t			*b;
	drawSurfRef_t		*dsr;

	// emit a leaf
	if (numleafs >= MAX_MAP_LEAFS)
		Error ("MAX_MAP_LEAFS");

	leaf_p = &dleafs[numleafs];
	numleafs++;

	leaf_p->cluster = node->cluster;
	leaf_p->area = node->area;

	//
	// write bounding box info
	//	
	VectorCopy (node->mins, leaf_p->mins);
	VectorCopy (node->maxs, leaf_p->maxs);
	
	//
	// write the leafbrushes
	//
	leaf_p->firstLeafBrush = numleafbrushes;
	for ( b = node->brushlist ; b ; b = b->next ) {
		if ( numleafbrushes >= MAX_MAP_LEAFBRUSHES ) {
			Error( "MAX_MAP_LEAFBRUSHES" );
		}
		dleafbrushes[numleafbrushes] = b->original->outputNumber;
		numleafbrushes++;
	}
	leaf_p->numLeafBrushes = numleafbrushes - leaf_p->firstLeafBrush;

	//
	// the world's static models that reach this leaf
	//
	leaf_p->firstStaticModel = numLeafStaticModels;
	if ( nummodels == 0 && !node->opaque ) {
		int i;
		for ( i = 0 ; i < numStaticModels ; i++ ) {
			if ( staticMins[i][0] > node->maxs[0] || staticMaxs[i][0] < node->mins[0]
				|| staticMins[i][1] > node->maxs[1] || staticMaxs[i][1] < node->mins[1]
				|| staticMins[i][2] > node->maxs[2] || staticMaxs[i][2] < node->mins[2] ) {
				continue;
			}
			if ( numLeafStaticModels >= MAX_LEAF_STATICMODELS ) {
				Error( "MAX_LEAF_STATICMODELS (%i)", MAX_LEAF_STATICMODELS );
			}
			dleafStaticModels[numLeafStaticModels++] = i;
		}
	}
	leaf_p->numStaticModels = numLeafStaticModels - leaf_p->firstStaticModel;

	// and the terrain patches, listed in the world's solid leaves as well as its open ones
	leaf_p->firstTerraPatch = numTerrainIndexes;
	leaf_p->numTerraPatches = 0;
	if ( nummodels == 0 ) {
		EmitLeafTerrain( leaf_p, node->mins, node->maxs );
	}

	//
	// write the surfaces visible in this leaf
	//
	if ( node->opaque ) {
		return;		// no leaffaces in solids
	}
	
	// add the drawSurfRef_t drawsurfs
	leaf_p->firstLeafSurface = numleafsurfaces;
	for ( dsr = node->drawSurfReferences ; dsr ; dsr = dsr->nextRef ) {
		if ( numleafsurfaces >= MAX_MAP_LEAFFACES)
			Error ("MAX_MAP_LEAFFACES");
		dleafsurfaces[numleafsurfaces] = dsr->outputNumber;
		numleafsurfaces++;			
	}


	leaf_p->numLeafSurfaces = numleafsurfaces - leaf_p->firstLeafSurface;
}


/*
============
EmitDrawNode_r
============
*/
int EmitDrawNode_r (node_t *node)
{
	dnode_t	*n;
	int		i;

	if (node->planenum == PLANENUM_LEAF)
	{
		EmitLeaf (node);
		return -numleafs;
	}

	// emit a node	
	if (numnodes == MAX_MAP_NODES)
		Error ("MAX_MAP_NODES");
	n = &dnodes[numnodes];
	numnodes++;

	VectorCopy (node->mins, n->mins);
	VectorCopy (node->maxs, n->maxs);

	if (node->planenum & 1)
		Error ("WriteDrawNodes_r: odd planenum");
	n->planeNum = node->planenum;

	//
	// recursively output the other nodes
	//	
	for (i=0 ; i<2 ; i++)
	{
		if (node->children[i]->planenum == PLANENUM_LEAF)
		{
			n->children[i] = -(numleafs + 1);
			EmitLeaf (node->children[i]);
		}
		else
		{
			n->children[i] = numnodes;	
			EmitDrawNode_r (node->children[i]);
		}
	}

	return n - dnodes;
}

//=========================================================



/*
============
SetModelNumbers
============
*/
void SetModelNumbers (void)
{
	int		i;
	int		models;
	char	value[10];

	models = 1;
	for ( i=1 ; i<num_entities ; i++ ) {
		if ( entities[i].brushes || entities[i].patches ) {
			sprintf ( value, "*%i", models );
			models++;
			SetKeyValue (&entities[i], "model", value);
		}
	}

}

/*
============
SetLightStyles
============
*/
#define	MAX_SWITCHED_LIGHTS	32
void SetLightStyles (void)
{
	int		stylenum;
	const char	*t;
	entity_t	*e;
	int		i, j;
	char	value[10];
	char	lighttargets[MAX_SWITCHED_LIGHTS][64];


	// any light that is controlled (has a targetname)
	// must have a unique style number generated for it

	stylenum = 0;
	for (i=1 ; i<num_entities ; i++)
	{
		e = &entities[i];

		t = ValueForKey (e, "classname");
		if (Q_strncasecmp (t, "light", 5))
			continue;
		t = ValueForKey (e, "targetname");
		if (!t[0])
			continue;
		
		// find this targetname
		for (j=0 ; j<stylenum ; j++)
			if (!strcmp (lighttargets[j], t))
				break;
		if (j == stylenum)
		{
			if (stylenum == MAX_SWITCHED_LIGHTS)
				Error ("stylenum == MAX_SWITCHED_LIGHTS");
			strcpy (lighttargets[j], t);
			stylenum++;
		}
		sprintf (value, "%i", 32 + j);
		SetKeyValue (e, "style", value);
	}

}

//===========================================================

/*
==================
BeginBSPFile
==================
*/
void BeginBSPFile( void ) {
	// these values may actually be initialized
	// if the file existed when loaded, so clear them explicitly
	nummodels = 0;
	numnodes = 0;
	numbrushsides = 0;
	numleafsurfaces = 0;
	numleafbrushes = 0;

	// leave leaf 0 as an error, because leafs are referenced as
	// negative number nodes
	numleafs = 1;

	CollectStaticModels();
	EmitTerrain();
}


/*
============
EndBSPFile
============
*/
void EndBSPFile( void ) {
	char	path[1024];

	DropUnseenTerrain();
	EmitPlanes ();
	UnparseEntities ();

	// write the map
	sprintf (path, "%s.bsp", source);
	_printf ("Writing %s\n", path);
	WriteBSPFile (path);
}


//===========================================================

/*
============
EmitBrushes
============
*/
/*
============
EmitShaderFlags

A shader record with these flags: MoHAA's .bsp keeps one per shader and flag set, the
flags being a brush's, which collision and impacts read.
============
*/
int	EmitShaderFlags( const char *shader, int surfaceFlags, int contents ) {
	int		i;

	if ( !shader ) {
		shader = "noshader";
	}
	for ( i = 0 ; i < numShaders ; i++ ) {
		if ( !Q_stricmp( shader, dshaders[i].shader ) && dshaders[i].surfaceFlags == surfaceFlags
			&& dshaders[i].contentFlags == contents ) {
			return i;
		}
	}
	if ( i == MAX_MAP_SHADERS ) {
		Error( "MAX_MAP_SHADERS" );
	}
	numShaders++;
	strcpy( dshaders[i].shader, shader );
	dshaders[i].surfaceFlags = surfaceFlags;
	dshaders[i].contentFlags = contents;
	FenceMaskName( ShaderInfoForShader( shader ), dshaders[i].fenceMaskImage, sizeof( dshaders[i].fenceMaskImage ) );
	return i;
}

// the surface types (paper to carpet): what a footstep or a bullet sounds like
#define SURF_MATERIALS	( SURF_PAPER | SURF_WOOD | SURF_METAL | SURF_ROCK | SURF_DIRT | SURF_GRILL | SURF_GRASS \
	| SURF_MUD | SURF_PUDDLE | SURF_GLASS | SURF_GRAVEL | SURF_SAND | SURF_FOLIAGE | SURF_SNOW | SURF_CARPET )

/*
============
BrushSurfaceFlags

As EA's compiler: every side of a brush carries the surface type (paper to carpet) of
all its sides, and stone when none of them names one. Each side keeps its own other
flags, so a caulk side doesn't hide the brush's drawn faces.
============
*/
int BrushSurfaceFlags( const bspbrush_t *b ) {
	int		j, f = 0;

	for ( j = 0 ; j < b->numsides ; j++ ) {
		if ( !b->sides[j].backSide ) {
			f |= b->sides[j].surfaceFlags;
		}
	}
	f &= SURF_MATERIALS;
	if ( !f ) {
		f = SURF_ROCK;
	}
	return f;
}

/*
============
EmitSideEquation

A fence side's texture coordinates as a plane equation each (s and t, in repeats of the
texture, as the side's drawn face has them): the game finds where a shot meets the side
in the fence mask from them. The equations are shared between sides; equation 0 is the
empty one a side without one points to.
============
*/
static int EmitSideEquation( const side_t *side ) {
	dsideequation_t	eq;
	const shaderInfo_t *si = side->shaderInfo;
	int				i;

	memset( &eq, 0, sizeof( eq ) );
	if ( g_bBrushPrimit == BPRIMIT_OLDBRUSHES ) {
		for ( i = 0 ; i < 4 ; i++ ) {
			eq.fSeq[i] = side->vecs[0][i] / si->width;
			eq.fTeq[i] = side->vecs[1][i] / si->height;
		}
	} else {
		vec3_t	texX, texY;
		ComputeAxisBase( mapplanes[side->planenum].normal, texX, texY );
		for ( i = 0 ; i < 3 ; i++ ) {
			eq.fSeq[i] = side->texMat[0][0] * texX[i] + side->texMat[0][1] * texY[i];
			eq.fTeq[i] = side->texMat[1][0] * texX[i] + side->texMat[1][1] * texY[i];
		}
		eq.fSeq[3] = side->texMat[0][2];
		eq.fTeq[3] = side->texMat[1][2];
	}

	if ( !numSideEquations ) {
		memset( &sideEquations[0], 0, sizeof( sideEquations[0] ) );
		numSideEquations = 1;
	}
	for ( i = 1 ; i < numSideEquations ; i++ ) {
		if ( !memcmp( &sideEquations[i], &eq, sizeof( eq ) ) ) {
			return i;
		}
	}
	if ( numSideEquations == MAX_MAP_SIDEEQATIONS ) {
		Error( "MAX_MAP_SIDEEQATIONS" );
	}
	sideEquations[numSideEquations] = eq;
	return numSideEquations++;
}

void EmitBrushes ( bspbrush_t *brushes ) {
	int				j;
	dbrush_t		*db;
	bspbrush_t		*b;
	dbrushside_t	*cp;
	int				brushFlags, recordContents;

	for ( b = brushes ; b ; b = b->next ) {
		if ( numbrushes == MAX_MAP_BRUSHES ) {
			Error( "MAX_MAP_BRUSHES" );
		}
		b->outputNumber = numbrushes;
		db = &dbrushes[numbrushes];
		numbrushes++;

		brushFlags = BrushSurfaceFlags( b );

		// the game's collision takes a brush's contents from this record: all its sides'
		// together, as EA's compiler writes them (a gate's nodraw sides and its fence face
		// make a fence brush), its detail as the map makes it
		recordContents = b->contents;
		for ( j = 0 ; j < b->numsides ; j++ ) {
			if ( b->sides[j].shaderInfo && !b->sides[j].backSide ) {
				recordContents |= b->sides[j].contents & ~( CONTENTS_DETAIL | CONTENTS_STRUCTURAL );
			}
		}

		db->shaderNum = EmitShaderFlags( b->contentShader->shader, b->contentShader->surfaceFlags | brushFlags, recordContents );
		db->firstSide = numbrushsides;

		// don't emit any generated backSide sides
		db->numSides = 0;
		for ( j=0 ; j<b->numsides ; j++ ) {
			if ( b->sides[j].backSide ) {
				continue;
			}
			if ( numbrushsides == MAX_MAP_BRUSHSIDES ) {
				Error( "MAX_MAP_BRUSHSIDES ");
			}
			cp = &dbrushsides[numbrushsides];
			db->numSides++;
			numbrushsides++;
			cp->planeNum = b->sides[j].planenum;
			cp->shaderNum = EmitShaderFlags( b->sides[j].shaderInfo->shader, b->sides[j].surfaceFlags | brushFlags, b->contents );
			cp->equationNum = 0;
			// a fence side whose shader names a mask image: where a shot meets it in the mask
			if ( b->sides[j].shaderInfo && ( b->sides[j].shaderInfo->contents & CONTENTS_FENCE )
				&& dshaders[cp->shaderNum].fenceMaskImage[0]
				&& Q_stricmp( dshaders[cp->shaderNum].fenceMaskImage, "ignore" ) ) {
				cp->equationNum = EmitSideEquation( &b->sides[j] );
			}
		}
	}

}


/*
==================
BeginModel
==================
*/
void BeginModel( void ) {
	dmodel_t	*mod;
	bspbrush_t	*b;
	entity_t	*e;
	vec3_t		mins, maxs;
	parseMesh_t	*p;
	int			i;

	if ( nummodels == MAX_MAP_MODELS ) {
		Error( "MAX_MAP_MODELS" );
	}
	mod = &dmodels[nummodels];

	//
	// bound the brushes
	//
	e = &entities[entity_num];

	ClearBounds (mins, maxs);
	for ( b = e->brushes ; b ; b = b->next ) {
		if ( !b->numsides ) {
			continue;	// not a real brush (origin brush, etc)
		}
		AddPointToBounds (b->mins, mins, maxs);
		AddPointToBounds (b->maxs, mins, maxs);
	}

	for ( p = e->patches ; p ; p = p->next ) {
		for ( i = 0 ; i < p->mesh.width * p->mesh.height ; i++ ) {
			AddPointToBounds( p->mesh.verts[i].xyz, mins, maxs );
		}
	}

	VectorCopy (mins, mod->mins);
	VectorCopy (maxs, mod->maxs);

	mod->firstSurface = numDrawSurfaces;
	mod->firstBrush = numbrushes;

	EmitBrushes( e->brushes );
}




/*
==================
EndModel
==================
*/
void EndModel( node_t *headnode ) {
	dmodel_t	*mod;

	qprintf ("--- EndModel ---\n");

	mod = &dmodels[nummodels];
	EmitDrawNode_r (headnode);
	mod->numSurfaces = numDrawSurfaces - mod->firstSurface;
	mod->numBrushes = numbrushes - mod->firstBrush;

	nummodels++;
}


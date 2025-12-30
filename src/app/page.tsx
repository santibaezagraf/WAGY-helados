// 'use client'

import { createClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import RefreshButton from '@/components/RefreshButton'

export default async function Home() {
    const supabase = await createClient();

    const  {data: { user } } = await supabase.auth.getUser();

    if (!user) {
        redirect('/login')
    }

    const { data: pedidos, error } = await supabase
        .from('pedidos')
        .select('*');

    if (error) {
        return ( 
          <div>Error al cargar los pedidos: {error.message}</div>
        );
    }

    return (
        <div className="flex min-h-screen flex-col items-center justify-center p-24 text-black">
            <h1 className="text-blue-600 text-4xl font-bold">Bienvenido {user.email}</h1>
            
            <div className="mt-6">
                <RefreshButton />
            </div>

            {pedidos && pedidos.length > 0 && (
              <pre className="mt-8 bg-gray-100 p-4 rounded-lg">
                {JSON.stringify(pedidos, null, 2)}
              </pre>
            )}
        </div>
    )
}